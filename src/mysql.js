// Talking to MySQL/MariaDB. Credentials always go through a private option file
// (--defaults-extra-file), never the command line, where `ps` would show them.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeAtomic } from "./config.js";

// MySQL option files accept double-quoted values with backslash escapes.
const quote = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function optionFileContent({ host, port, socket, username, password }) {
  const lines = ["# Database credentials Agouti uses for backups. Root-only (mode 0600).", "[client]"];
  lines.push(`user=${quote(username)}`, `password=${quote(password ?? "")}`);
  if (socket) lines.push(`socket=${quote(socket)}`);
  else lines.push(`host=${quote(host)}`, `port=${port}`);
  return lines.join("\n") + "\n";
}

export async function writeOptionFile(file, db) {
  await writeAtomic(file, optionFileContent(db), 0o600);
}

// Connects and describes the database: server version, table count, size.
// Returns { ok: true, version, tables, bytes } or { ok: false, message }.
export async function inspectDatabase(optionFile, database, { client = process.env.AGOUTI_MYSQL || "mysql" } = {}) {
  const sql = "SELECT VERSION(), COUNT(*), COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE()";
  const r = await run(client, [`--defaults-extra-file=${optionFile}`, "--batch", "--skip-column-names", "--connect-timeout=10", "-e", sql, database]);
  if (r.missing) return { ok: false, message: "The mysql client isn't installed, so the connection couldn't be checked.", clientMissing: true };
  if (r.code !== 0) return { ok: false, message: cleanError(r.stderr) };
  const [version, tables, bytes] = r.stdout.trim().split("\t");
  return { ok: true, version: describeVersion(version), tables: Number(tables), bytes: Number(bytes) };
}

function describeVersion(v = "") {
  const num = v.match(/^\d+\.\d+/)?.[0] ?? v;
  return /mariadb/i.test(v) ? `MariaDB ${num}` : `MySQL ${num}`;
}

function cleanError(stderr) {
  const line = stderr.split("\n").find((l) => /ERROR/.test(l)) ?? stderr.trim().split("\n").at(-1) ?? "unknown error";
  return line.replace(/^(mysql|mariadb): /, "").trim();
}

// A strong password that's safe inside SQL quotes and option files.
export function generatePassword() {
  return randomBytes(24).toString("base64url");
}

// SQL for a dedicated read-only backup user, scoped to one database. It can read
// everything mysqldump needs, but can't change or delete anything.
export function backupUserSql({ database, username = "agouti_backup", host = "localhost", password }) {
  const id = (s) => "`" + s.replace(/`/g, "``") + "`";
  const str = (s) => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
  return [
    `CREATE USER ${str(username)}@${str(host)} IDENTIFIED BY ${str(password)};`,
    `GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT ON ${id(database)}.* TO ${str(username)}@${str(host)};`,
  ].join("\n");
}

function run(cmd, args) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ missing: e.code === "ENOENT", code: -1, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
