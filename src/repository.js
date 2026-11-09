// Core repository operations. No prompts and no printing: both the commands and
// the interactive app call these, so the two can never drift apart.
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, saveConfig, saveCredentials, saveRecoveryKey } from "./config.js";
import { paths } from "./paths.js";
import { generateRecoveryKey } from "./recovery-key.js";
import { EXIT, ensureRestic, lastLine, probeRepository, resticEnv, run } from "./restic.js";
import { UserError } from "./ui.js";

export async function assertNotConfigured(p = paths()) {
  const existing = await loadConfig(p);
  if (existing?.repository) {
    throw new UserError(`This server already uses a repository: ${existing.repository}`, `To start over, remove ${p.config} first.`);
  }
  return existing;
}

// Creates a new encrypted repository and saves the setup. Returns the recovery key.
export async function createRepository({ repository, credentials }, { p = paths(), log } = {}) {
  const existing = await assertNotConfigured(p);
  const bin = await ensureRestic({ p, log });

  const key = generateRecoveryKey();
  await writeSecrets(key, credentials, p);
  try {
    const env = await resticEnv({ repository }, p);
    // Make sure we aren't about to clobber someone else's repository.
    const probe = await probeRepository(bin, env);
    if (probe.state === "ok" || probe.state === "wrong-key") {
      throw new UserError("There is already a backup repository at that location.", "To use it from this server, connect to it with its recovery key.");
    }
    if (probe.state === "error") throw new UserError(`Can't reach the repository: ${probe.message}`);

    const { code, stderr } = await run(bin, ["init"], { env });
    if (code !== 0) throw new UserError(`Creating the repository failed: ${lastLine(stderr)}`);
  } catch (err) {
    await removeSecrets(p);
    throw err;
  }

  await saveConfig({ ...(existing ?? {}), repository, projects: existing?.projects ?? {} }, p);
  return key;
}

// Uses an existing repository from this server, after checking the key opens it.
export async function connectRepository({ repository, credentials, key }, { p = paths(), log } = {}) {
  // Refuse even for the same repository: rewriting the key files of a working
  // setup, then deleting them because a mistyped key failed, would break it.
  const existing = await assertNotConfigured(p);
  const bin = await ensureRestic({ p, log });

  await writeSecrets(key, credentials, p);
  const probe = await probeRepository(bin, await resticEnv({ repository }, p));
  if (probe.state !== "ok") {
    await removeSecrets(p);
    if (probe.state === "missing")
      throw new UserError(`There's no repository at ${repository}.`, 'To create one, choose "new repository" or run `sudo agouti init`.');
    if (probe.state === "wrong-key") throw new UserError("That recovery key doesn't open this repository.");
    throw new UserError(`Can't reach the repository: ${probe.message}`);
  }

  await saveConfig({ ...(existing ?? {}), repository, projects: existing?.projects ?? {} }, p);
}

// Counts restore points; doubles as a "can we still reach storage?" check.
// Before a backup: can this server reach the storage at all? restic itself keeps
// retrying an unreachable storage for about 15 minutes per call, so an unplugged
// drive meant half an hour of silence and then a message blaming the database.
// Returns { ok } or { ok: false, message, hint }, in seconds.
export async function storageReachable(config, { p = paths(), log, timeout = 60_000 } = {}) {
  const repo = config.repository;
  if (isLocal(repo)) {
    // A drive that dropped out can leave a mount that hangs instead of failing.
    const config = await Promise.race([stat(join(repo, "config")).then(() => true, () => false), sleep(10_000).then(() => "hung")]);
    if (config === true) return { ok: true };
    return {
      ok: false,
      message: config === "hung" ? `The backup folder ${repo} doesn't respond.` : `The backup folder ${repo} isn't there.`,
      hint: "Is the drive connected and mounted?",
    };
  }
  const bin = await ensureRestic({ p, log });
  const r = await run(bin, ["cat", "config", "--no-lock"], { env: await resticEnv(config, p), timeout });
  if (r.code === 0) return { ok: true };
  if (r.timedOut) return { ok: false, message: `The backup storage didn't answer within ${timeout / 1000} seconds.`, hint: "Check this server's network connection and the storage provider's status." };
  if (r.code === EXIT.WRONG_PASSWORD) return { ok: false, message: "The recovery key on this server doesn't open the backup storage.", hint: `Check ${p.recoveryKey}.` };
  return { ok: false, message: `Can't reach the backup storage: ${resticReason(r.stderr)}.`, hint: `Check the network, and the storage keys in ${p.credentials}.` };
}

// "s3:...", "sftp:..." are remote; a Windows drive (D:\backups) is local.
const isLocal = (repo) => !/^[a-z0-9]+:/i.test(repo) || /^[a-z]:[\\/]/i.test(repo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());

// restic's "Fatal: ..." line, without the JSON wrapper it has in --json mode.
function resticReason(stderr) {
  const lines = stderr.trim().split("\n").map((l) => {
    try {
      return JSON.parse(l).message ?? l;
    } catch {
      return l;
    }
  });
  const fatal = lines.find((l) => /^Fatal:/.test(l)) ?? lines.at(-1) ?? "";
  return fatal.replace(/^Fatal:\s*/, "").split("\n")[0].replace(/[.:]\s*$/, "");
}

// Unfinished uploads: restic writes a data file under a temporary name and renames
// it when it's complete, so one killed mid-upload (kill -9, a crash, a drive pulled
// out) leaves "<id>-tmp-<n>" behind. Nothing refers to it, and neither prune nor
// check removes it. Local storage only; files untouched for an hour, since a backup
// from another server sharing the storage may be writing one right now.
// Returns { files, bytes } found (and removed, unless dryRun).
export async function unfinishedUploads(config, { dryRun = false, olderThan = 3600_000, now = Date.now() } = {}) {
  const found = { files: 0, bytes: 0 };
  if (!isLocal(config.repository)) return found;
  const data = join(config.repository, "data");
  for (const sub of await readdir(data).catch(() => [])) {
    for (const name of await readdir(join(data, sub)).catch(() => [])) {
      if (!/^[0-9a-f]{64}-tmp-\d+$/.test(name)) continue;
      const file = join(data, sub, name);
      const s = await stat(file).catch(() => null);
      if (!s?.isFile() || now - s.mtimeMs < olderThan) continue;
      if (!dryRun && (await rm(file).then(() => false, () => true))) continue;
      found.files++;
      found.bytes += s.size;
    }
  }
  return found;
}

export async function repositoryStatus(config, { p = paths(), log } = {}) {
  const reach = await storageReachable(config, { p, log });
  if (!reach.ok) return { reachable: false, message: reach.message, hint: reach.hint };
  const bin = await ensureRestic({ p, log });
  const env = await resticEnv(config, p);
  const { code, stdout, stderr } = await run(bin, ["snapshots", "--json", "--no-lock"], { env });
  if (code !== 0) return { reachable: false, message: lastLine(stderr) };
  // One restore point is several snapshots (database, files, ...) sharing a point tag.
  const points = new Set((JSON.parse(stdout || "[]") ?? []).map((s) => s.tags?.find((t) => t.startsWith("point=")) ?? s.id));
  return { reachable: true, snapshots: points.size };
}

// For S3 repositories given as a string: keys come from the usual AWS variables.
export function s3CredentialsFromEnv(repository, env = process.env) {
  const creds = {};
  for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"]) {
    if (env[k]) creds[k] = env[k];
  }
  if (repository.includes(".r2.cloudflarestorage.com")) creds.AWS_DEFAULT_REGION ??= "auto";
  return creds;
}

async function writeSecrets(key, credentials, p) {
  await saveRecoveryKey(key, p);
  await saveCredentials(credentials, p);
}

function removeSecrets(p) {
  return Promise.all([rm(p.recoveryKey, { force: true }), rm(p.credentials, { force: true })]);
}
