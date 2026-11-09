import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import YAML from "yaml";
import { paths } from "./paths.js";
import { isWindows } from "./platform.js";
import { UserError } from "./ui.js";

const HEADER = ` Agouti configuration. Written by \`agouti init\` and \`agouti add\`; safe to edit.
 Secrets are not stored here: see credentials.env and recovery-key in this directory.`;

export async function loadConfig(p = paths()) {
  let text;
  try {
    text = await readFile(p.config, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw fsError(err, p.config);
  }
  let config;
  try {
    config = YAML.parse(text) ?? {};
  } catch (err) {
    throw new UserError(`Can't parse ${p.config}: ${err.message}`);
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new UserError(`${p.config} should contain a YAML mapping (key: value).`);
  }
  config.projects ??= {};
  return config;
}

// Like loadConfig, but for commands that need a repository to exist.
export async function requireConfig(p = paths()) {
  const config = await loadConfig(p);
  if (!config?.repository) {
    throw new UserError("Agouti isn't set up on this server yet.", "Run `sudo agouti init` (new repository) or `sudo agouti connect` (existing one).");
  }
  return config;
}

export async function saveConfig(config, p = paths()) {
  const doc = new YAML.Document(config);
  doc.commentBefore = HEADER;
  await writeAtomic(p.config, doc.toString(), 0o644);
}

// credentials.env holds KEY=value lines handed to restic as environment variables
// (S3 keys and the like). Readable by root only.
export async function loadCredentials(p = paths()) {
  let text;
  try {
    text = await readFile(p.credentials, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw fsError(err, p.credentials);
  }
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = unquote(m[2].trim());
  }
  return env;
}

export async function saveCredentials(env, p = paths()) {
  const lines = ["# Credentials for the backup repository. Keep this file private (mode 0600)."];
  for (const [k, v] of Object.entries(env)) {
    if (/[\n\r]/.test(v)) throw new UserError(`Credential ${k} contains a line break.`);
    lines.push(`${k}=${JSON.stringify(v)}`);
  }
  await writeAtomic(p.credentials, lines.join("\n") + "\n", 0o600);
}

export async function saveRecoveryKey(key, p = paths()) {
  await writeAtomic(p.recoveryKey, key + "\n", 0o600);
}

// Write to a temp file and rename, so a crash never leaves a half-written file.
// The mode is set at creation, so secrets are never readable by others, even briefly.
export async function writeAtomic(file, content, mode) {
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o755 });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, content, { mode });
    await rename(tmp, file);
  } catch (err) {
    throw fsError(err, file);
  }
}

export function fsError(err, file) {
  if (err.code === "EACCES" || err.code === "EPERM") {
    return new UserError(`Permission denied: ${file}`, isWindows() ? "Run it in a terminal opened with \"Run as administrator\"." : "Run this command with sudo.");
  }
  return err;
}

function unquote(v) {
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      /* fall through */
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}
