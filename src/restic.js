import { spawn } from "./children.js";
import { createHash } from "node:crypto";
import { access, chmod, constants, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { fsError, loadCredentials } from "./config.js";
import { paths } from "./paths.js";
import { UserError, dim } from "./ui.js";

// Pinned restic release. To upgrade: change the version and copy the hashes for the
// linux_*.bz2 and windows_*.zip files from
// https://github.com/restic/restic/releases/download/v<version>/SHA256SUMS
export const RESTIC_VERSION = "0.19.1";
const SHA256 = {
  linux: {
    amd64: "f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c",
    arm64: "a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465",
    arm: "1edc5f67b0dd0d028586ab28c34b4da7522eabce933b3f6cd04f9ea184c2a502",
    386: "c715a3de2fffb70a4c7864ef2d195db8bad96bc0284757cd5bd0f43362f2a191",
  },
  win32: {
    amd64: "da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d",
    386: "24147168e7988af20e4957d06ab7a9ba73792755150ce1ff270ad586c37fd160",
  },
};
const ARCH = { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" };

// Exit codes restic documents for scripts.
export const EXIT = { OK: 0, FATAL: 1, NO_REPO: 10, LOCKED: 11, WRONG_PASSWORD: 12 };

// Returns the path of a restic binary, downloading the pinned version if needed.
// AGOUTI_RESTIC points at a binary you provide yourself (used as-is, not verified).
export async function ensureRestic({ p = paths(), log = () => {} } = {}) {
  if (process.env.AGOUTI_RESTIC) return process.env.AGOUTI_RESTIC;

  const windows = process.platform === "win32";
  const bin = join(p.binDir, `restic-${RESTIC_VERSION}${windows ? ".exe" : ""}`);
  try {
    await access(bin, constants.X_OK);
    return bin;
  } catch {
    /* not installed yet */
  }

  if (!SHA256[process.platform]) {
    throw new UserError(`Agouti runs on Linux and Windows servers (this is ${process.platform}).`, "Set AGOUTI_RESTIC to a restic binary to try it anyway.");
  }
  const arch = ARCH[process.arch];
  if (!arch || !SHA256[process.platform][arch]) throw new UserError(`No restic build for CPU architecture ${process.arch}.`, "Set AGOUTI_RESTIC to a restic binary.");

  const name = windows ? `restic_${RESTIC_VERSION}_windows_${arch}.zip` : `restic_${RESTIC_VERSION}_linux_${arch}.bz2`;
  const url = `https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${name}`;
  log(`Downloading restic ${RESTIC_VERSION} ${dim(`(${arch})`)} ...`);

  let compressed;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    compressed = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new UserError(
      `Couldn't download restic from ${url}: ${err.cause?.message ?? err.message}`,
      "Check this server's internet access, or set AGOUTI_RESTIC to a restic binary.",
    );
  }

  const actual = createHash("sha256").update(compressed).digest("hex");
  const expected = SHA256[process.platform][arch];
  if (actual !== expected) {
    throw new UserError(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}. Nothing was installed.`);
  }

  const binary = windows ? unzipOne(compressed, /\.exe$/i) : await bunzip2(compressed);
  try {
    await mkdir(p.binDir, { recursive: true, mode: 0o755 });
    const tmp = `${bin}.tmp-${process.pid}`;
    await writeFile(tmp, binary, { mode: 0o755 });
    await chmod(tmp, 0o755);
    await rename(tmp, bin);
  } catch (err) {
    throw fsError(err, bin);
  }

  const { code, stdout } = await run(bin, ["version"]);
  if (code !== 0 || !stdout.includes(RESTIC_VERSION)) {
    await rm(bin, { force: true });
    throw new UserError(`The downloaded restic binary doesn't run on this server (${stdout.trim() || `exit ${code}`}).`);
  }
  return bin;
}

// The one file in a zip archive whose name matches, unpacked. restic's Windows
// release is a zip holding just restic_<version>_windows_<arch>.exe; the archive's
// checksum was verified before this runs. Reads the central directory (sizes in the
// local headers can be left out), stored or deflated entries only.
export function unzipOne(zip, nameRe) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new UserError("The restic download isn't a valid zip file.");
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) break;
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (!nameRe.test(name)) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new UserError(`Can't unpack ${name} (zip method ${method}).`);
  }
  throw new UserError("The restic download doesn't contain restic.");
}

function bunzip2(buf) {
  return new Promise((resolve, reject) => {
    const child = spawn("bzip2", ["-dc"], { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      reject(e.code === "ENOENT" ? new UserError("bzip2 is needed to unpack restic.", "Install it (e.g. `apt install bzip2`) and try again.") : e),
    );
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`bzip2 failed: ${err.trim()}`))));
    child.stdin.end(buf);
  });
}

// The environment restic runs with for this server's repository.
export async function resticEnv(config, p = paths(), extra = {}) {
  return {
    ...process.env,
    // Agouti's own settings (e.g. the healthcheck URL) share the file but aren't restic's business.
    ...Object.fromEntries(Object.entries(await loadCredentials(p)).filter(([k]) => !k.startsWith("AGOUTI_"))),
    RESTIC_REPOSITORY: config.repository,
    RESTIC_PASSWORD_FILE: p.recoveryKey,
    RESTIC_CACHE_DIR: p.cacheDir,
    ...extra,
  };
}

// Runs restic and collects its output. Never throws on a non-zero exit: callers
// decide what an exit code means. stdin can be a string/Buffer or a readable stream.
export function run(bin, args, { env = process.env, stdin, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"], ...(timeout ? { timeout, killSignal: "SIGKILL" } : {}) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    // A program that exits without reading its input (EPIPE) is not an error here.
    child.stdin.on("error", () => {});
    child.on("close", (code, signal) => resolve({ code, stdout, stderr, timedOut: Boolean(timeout && signal === "SIGKILL") }));
    if (stdin && typeof stdin.pipe === "function") stdin.pipe(child.stdin);
    else child.stdin.end(stdin ?? "");
  });
}

// Is there a repository at the configured location, and does our key open it?
export async function probeRepository(bin, env) {
  const { code, stderr } = await run(bin, ["cat", "config", "--no-lock"], { env });
  if (code === EXIT.OK) return { state: "ok" };
  if (code === EXIT.NO_REPO) return { state: "missing" };
  if (code === EXIT.WRONG_PASSWORD) return { state: "wrong-key" };
  // restic ends with the repository's address; the reason is on the "Fatal:" line.
  const fatal = stderr.split("\n").find((l) => l.startsWith("Fatal:"));
  return { state: "error", message: fatal ? fatal.replace(/^Fatal:\s*/, "") : lastLine(stderr) };
}

// An interrupted restic (a killed backup, a reboot) leaves its lock in the storage.
// Backups don't mind, but check, forget and prune need the repository to themselves
// and refuse until it's gone. `restic unlock` removes only stale locks: from a
// process on this machine that's no longer running, or not refreshed for 30 minutes
// (another server's run that died). A live run's lock stays. Failing is harmless
// (e.g. append-only storage that can't delete): the next step reports the lock.
export async function clearStaleLocks(bin, env) {
  const r = await run(bin, ["unlock"], { env });
  return { ok: r.code === 0, removed: /removed|successfully/i.test(r.stdout + r.stderr) };
}

// What a restic run that couldn't lock the repository should say.
export function lockedMessage(what) {
  return `${what}: the storage is in use by another backup, restore or check that's still running. It runs again next time; if this keeps happening, look for a stuck agouti or restic process.`;
}

export function lastLine(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  return lines.at(-1) ?? "";
}

// Runs restic with --json and hands each parsed message to onMessage as it
// arrives (status updates, errors, the final summary). Non-JSON lines (such as
// stderr from a --stdin-from-command program) are collected in `stderr`.
export function runJson(bin, args, { env = process.env, onMessage = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    // --json goes first: anything after "--" belongs to a --stdin-from-command program.
    const child = spawn(bin, ["--json", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const messages = [];
    let stderr = "";
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          messages.push(msg);
          onMessage(msg);
        } catch {
          stderr += line + "\n";
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // restic writes per-file errors ("error" messages) to stderr, even with --json.
      const errors = [];
      for (const line of stderr.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.message_type === "error") errors.push(msg);
        } catch {
          // A subprocess's own output, not a message from restic.
        }
      }
      resolve({ code, signal, messages, errors, stderr, summary: messages.findLast((m) => m.message_type === "summary") });
    });
  });
}
