import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, constants, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fsError, loadCredentials } from "./config.js";
import { paths } from "./paths.js";
import { UserError, dim } from "./ui.js";

// Pinned restic release. To upgrade: change the version and copy the hashes for the
// linux_*.bz2 files from https://github.com/restic/restic/releases/download/v<version>/SHA256SUMS
export const RESTIC_VERSION = "0.19.1";
const SHA256 = {
  amd64: "f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c",
  arm64: "a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465",
  arm: "1edc5f67b0dd0d028586ab28c34b4da7522eabce933b3f6cd04f9ea184c2a502",
  386: "c715a3de2fffb70a4c7864ef2d195db8bad96bc0284757cd5bd0f43362f2a191",
};
const ARCH = { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" };

// Exit codes restic documents for scripts.
export const EXIT = { OK: 0, FATAL: 1, NO_REPO: 10, LOCKED: 11, WRONG_PASSWORD: 12 };

// Returns the path of a restic binary, downloading the pinned version if needed.
// AGOUTI_RESTIC points at a binary you provide yourself (used as-is, not verified).
export async function ensureRestic({ p = paths(), log = () => {} } = {}) {
  if (process.env.AGOUTI_RESTIC) return process.env.AGOUTI_RESTIC;

  const bin = join(p.binDir, `restic-${RESTIC_VERSION}`);
  try {
    await access(bin, constants.X_OK);
    return bin;
  } catch {
    /* not installed yet */
  }

  if (process.platform !== "linux") {
    throw new UserError(`Agouti runs on Linux servers (this is ${process.platform}).`, "Set AGOUTI_RESTIC to a restic binary to try it anyway.");
  }
  const arch = ARCH[process.arch];
  if (!arch) throw new UserError(`No restic build for CPU architecture ${process.arch}.`, "Set AGOUTI_RESTIC to a restic binary.");

  const name = `restic_${RESTIC_VERSION}_linux_${arch}.bz2`;
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
  if (actual !== SHA256[arch]) {
    throw new UserError(`Checksum mismatch for ${name}: expected ${SHA256[arch]}, got ${actual}. Nothing was installed.`);
  }

  const binary = await bunzip2(compressed);
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
export function run(bin, args, { env = process.env, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    // A program that exits without reading its input (EPIPE) is not an error here.
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve({ code, stdout, stderr }));
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
  return { state: "error", message: lastLine(stderr) };
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
    child.on("close", (code) => resolve({ code, messages, stderr, summary: messages.findLast((m) => m.message_type === "summary") }));
  });
}
