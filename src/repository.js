// Core repository operations. No prompts and no printing: both the commands and
// the interactive app call these, so the two can never drift apart.
import { rm } from "node:fs/promises";
import { loadConfig, saveConfig, saveCredentials, saveRecoveryKey } from "./config.js";
import { paths } from "./paths.js";
import { generateRecoveryKey } from "./recovery-key.js";
import { ensureRestic, lastLine, probeRepository, resticEnv, run } from "./restic.js";
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
export async function repositoryStatus(config, { p = paths(), log } = {}) {
  const bin = await ensureRestic({ p, log });
  const env = await resticEnv(config, p);
  const { code, stdout, stderr } = await run(bin, ["snapshots", "--json", "--no-lock"], { env });
  if (code !== 0) return { reachable: false, message: lastLine(stderr) };
  return { reachable: true, snapshots: JSON.parse(stdout || "[]").length };
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
