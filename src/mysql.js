// Talking to MySQL/MariaDB. Credentials always go through a private option file
// (--defaults-extra-file), never the command line, where `ps` would show them.
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn } from "./children.js";
import { randomBytes, createHash } from "node:crypto";
import { writeAtomic } from "./config.js";
import { UserError } from "./ui.js";

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

// Connects and describes the database: server version, table count, size, and
// whether this user can see stored procedures/functions (see routinesVisible).
// Returns { ok: true, version, tables, bytes, routinesVisible } or { ok: false, message }.
export async function inspectDatabase(optionFile, database, { client = mysqlClient() } = {}) {
  const sql =
    "SELECT VERSION(), COUNT(*), COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE(); SHOW GRANTS";
  const r = await run(client, [`--defaults-extra-file=${optionFile}`, "--batch", "--skip-column-names", "--connect-timeout=10", "--default-character-set=utf8mb4", "-e", sql, database]);
  if (r.missing) return { ok: false, message: "The mysql client isn't installed, so the connection couldn't be checked.", clientMissing: true };
  if (r.code !== 0) return { ok: false, message: cleanError(r.stderr) };
  const [first, ...grants] = r.stdout.trim().split(/\r?\n/);
  const [version, tables, bytes] = first.split("\t");
  return { ok: true, version: describeVersion(version), tables: Number(tables), bytes: Number(bytes), routinesVisible: routinesVisible(grants, database) };
}

// mysqldump --routines silently skips procedures and functions the user isn't
// allowed to see. A read-only user needs SHOW_ROUTINE (MySQL 8.0.20+), global
// SELECT, or SELECT on mysql.proc (MariaDB); the app's own user usually has
// ALTER ROUTINE or ALL on its database. With no grants to look at, assume visible.
export function routinesVisible(grants, database) {
  if (!grants.length) return true;
  return grants.map(parseGrant).some((g) => {
    if (!g) return false;
    const has = (...names) => names.some((n) => g.privs.includes(n));
    if (g.db === "*") return has("ALL PRIVILEGES", "SHOW_ROUTINE", "SHOW CREATE ROUTINE", "SELECT");
    if (g.db === "mysql" && (g.table === "*" || g.table === "proc")) return has("ALL PRIVILEGES", "SELECT");
    return g.table === "*" && dbPatternMatches(g.db, database) && has("ALL PRIVILEGES", "ALTER ROUTINE", "CREATE ROUTINE");
  });
}

// "GRANT SELECT, SHOW VIEW ON `shop\_prod`.* TO ..." → { privs, db, table }.
// --batch output escapes backslashes once more, so `shop\\_prod` is accepted too.
function parseGrant(line) {
  const m = line.match(/^GRANT (.+?) ON (`(?:[^`]|``)*`|\*)\.(`(?:[^`]|``)*`|\*) TO /);
  if (!m) return null;
  const unquote = (x) => (x === "*" ? "*" : x.slice(1, -1).replace(/``/g, "`").replace(/\\\\/g, "\\"));
  return { privs: m[1].split(",").map((x) => x.trim().toUpperCase()), db: unquote(m[2]), table: unquote(m[3]) };
}

// Database names in grants are LIKE patterns: _ and % are wildcards, \_ and \% literal.
function dbPatternMatches(pattern, database) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) re += escapeRe(pattern[++i]);
    else if (c === "_") re += ".";
    else if (c === "%") re += ".*";
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`).test(database);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function describeVersion(v = "") {
  const num = v.match(/^\d+\.\d+/)?.[0] ?? v;
  return /mariadb/i.test(v) ? `MariaDB ${num}` : `MySQL ${num}`;
}

export function cleanError(stderr) {
  const line = stderr.split(/\r?\n/).find((l) => /ERROR/.test(l)) ?? stderr.trim().split(/\r?\n/).at(-1) ?? "unknown error";
  return line.replace(/^(mysql|mariadb): /, "").trim();
}

// SQL quoting: identifiers (`name`) and strings ('text').
export const id = (s) => "`" + String(s).replace(/`/g, "``") + "`";
export const str = (s) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";

// Newer MariaDB packages only install mariadb and mariadb-dump, without the mysql names.
// Windows: programs end in .exe, and the MySQL installer doesn't always put its bin
// folder on the PATH (a scheduled task's PATH is the system one), so also look in
// its usual place, newest version first. Returns the full path there.
const onPath = (name) =>
  (process.env.PATH ?? "").split(delimiter).some((dir) => {
    try {
      accessSync(join(dir || ".", process.platform === "win32" ? `${name}.exe` : name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
export function windowsInstalls(env = process.env) {
  const out = [];
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean)) {
    for (const vendor of ["MySQL", "MariaDB"]) {
      const dirs = (() => {
        try {
          return readdirSync(join(root, vendor));
        } catch {
          return [];
        }
      })();
      // "MySQL Server 8.0", "MariaDB 11.4": newest first.
      for (const d of dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) out.push(join(root, vendor, d, "bin"));
    }
  }
  return out;
}
const firstInstalled = (...names) => {
  const found = names.find(onPath);
  if (found || process.platform !== "win32") return found ?? names[0];
  for (const dir of windowsInstalls()) for (const n of names) if (existsSync(join(dir, `${n}.exe`))) return join(dir, `${n}.exe`);
  return names[0];
};

export const mysqlClient = () => process.env.AGOUTI_MYSQL || firstInstalled("mysql", "mariadb");
export const dumpClient = () => process.env.AGOUTI_MYSQLDUMP || firstInstalled("mysqldump", "mariadb-dump");

// Runs SQL with the given option file. Returns { ok, rows: [[...]], error, missing }.
export async function query(optionFile, sql, { database } = {}) {
  const r = await run(mysqlClient(), [
    `--defaults-extra-file=${optionFile}`,
    "--batch",
    "--skip-column-names",
    "--connect-timeout=10",
    // Also keeps the client quiet about an unknown console code page (Windows over SSH).
    "--default-character-set=utf8mb4",
    "-e",
    sql,
    ...(database ? [database] : []),
  ]);
  if (r.missing) return { ok: false, missing: true, error: "The mysql client isn't installed." };
  if (r.code !== 0) return { ok: false, error: cleanError(r.stderr) };
  // mysql.exe on Windows ends lines with \r\n.
  const rows = r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split("\t"));
  return { ok: true, rows };
}

// A strong password that's safe inside SQL quotes and option files.
export function generatePassword() {
  return randomBytes(24).toString("base64url");
}

// SQL for a dedicated read-only backup user, scoped to one database. It can read
// everything mysqldump needs, but can't change or delete anything.
// SHOW_ROUTINE lets it see stored procedures/functions; without it mysqldump
// silently leaves them out. It's read-only too.
// flavor: which server the SQL is for (see clientFlavor). The grant that lets a
// read-only user see stored procedures is different on each and an error on the
// other, which would stop a pasted script halfway. Unknown: both, as comments.
// IF NOT EXISTS + ALTER: running it again (say, after a failed first try, with a
// new password) updates the existing user instead of stopping at "already exists".
export function backupUserSql({ database, username, host = "localhost", password, flavor }) {
  const who = `${str(username)}@${str(host)}`;
  return [
    `CREATE USER IF NOT EXISTS ${who} IDENTIFIED BY ${str(password)};`,
    `ALTER USER ${who} IDENTIFIED BY ${str(password)};`,
    `GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT ON ${id(database)}.* TO ${who};`,
    ...(flavor === "mariadb"
      ? [`GRANT SELECT ON mysql.proc TO ${who};`]
      : flavor === "mysql"
        ? [`GRANT SHOW_ROUTINE ON *.* TO ${who};`]
        : [
            "-- To back up stored procedures too, also run the line for your server:",
            `-- MySQL 8.0.20+: GRANT SHOW_ROUTINE ON *.* TO ${who};`,
            `-- MariaDB:       GRANT SELECT ON mysql.proc TO ${who};`,
          ]),
  ].join("\n");
}

// "mysql" or "mariadb", going by the client installed here (the same family as a
// local server, nearly always). null when there's no client to ask.
export async function clientFlavor() {
  const r = await run(mysqlClient(), ["--version"]);
  if (r.missing || r.code !== 0) return null;
  return /mariadb/i.test(r.stdout) ? "mariadb" : "mysql";
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

// How to get the mysql/mysqldump programs on this system.
export const installClientHint = () =>
  process.platform === "win32"
    ? "They come with MySQL (C:\\Program Files\\MySQL\\MySQL Server <version>\\bin). Install MySQL Server or MySQL Shell, or add that bin folder to the system PATH, and try again."
    : "Install it (e.g. `apt install mysql-client` or `apt install mariadb-client`) and try again.";

// Shown when routinesVisible() is false.
export function routinesWarning(username) {
  return [
    `${username} can't see stored procedures and functions, so backups would silently leave them out.`,
    `If this database has any, fix it as a MySQL admin: GRANT SHOW_ROUTINE ON *.* TO '${username}'@'<host>';`,
    "(MariaDB: GRANT SELECT ON mysql.proc TO ...). The privilege is read-only.",
  ].join("\n  ");
}

// The mysqldump command for one database. Consistent without locking InnoDB
// tables (--single-transaction), streams rows instead of buffering (--quick),
// and includes routines, triggers and events. Not compressed here: restic
// compresses and deduplicates, which compressed input would defeat.
export async function dumpCommand(optionFile, database, { bin = dumpClient() } = {}) {
  const r = await run(bin, ["--version"]);
  if (r.missing)
    throw new UserError("mysqldump isn't installed.", installClientHint());
  const mariadbClient = /mariadb/i.test(r.stdout);
  return [
    bin,
    `--defaults-extra-file=${optionFile}`,
    "--single-transaction",
    "--quick",
    "--routines",
    "--triggers",
    "--events",
    "--hex-blob",
    "--no-tablespaces",
    "--default-character-set=utf8mb4",
    // Identical data gives an identical dump, so restic stores nothing new for it.
    "--skip-dump-date",
    // MySQL's client only: don't need RELOAD for GTIDs, and work against MariaDB/older servers.
    ...(mariadbClient ? [] : ["--set-gtid-purged=OFF", "--column-statistics=0"]),
    // No --databases: the dump has no CREATE DATABASE/USE, so it can be loaded
    // into any database (a throwaway one for verification, or a renamed restore).
    database,
  ];
}

// Creates (or resets) a read-only backup user for one app, through an admin
// connection: the same privileges as backupUserSql(). One user per app, so
// setting up a second app never changes the first one's password.
// host: "localhost" for a local server (socket), "%" for one reached over the network.
// One backup user per app: two apps sharing one would share its password, and
// setting up the second would lock out the first. MySQL allows 32 characters, so
// a long name keeps its start plus a short code from the full name: two long,
// similar names don't end up as the same user.
export function backupUserName(app) {
  const name = `agouti_${app.replace(/[^A-Za-z0-9_]/g, "_")}`;
  if (name.length <= 32) return name;
  return `${name.slice(0, 25).replace(/_+$/, "")}_${createHash("sha256").update(app).digest("hex").slice(0, 6)}`;
}

export async function createBackupUser(adminFile, { app, database, host = "localhost" }) {
  const username = backupUserName(app);
  const password = generatePassword();
  const who = `${str(username)}@${str(host)}`;
  const r = await query(
    adminFile,
    `CREATE USER IF NOT EXISTS ${who} IDENTIFIED BY ${str(password)}; ALTER USER ${who} IDENTIFIED BY ${str(password)}; ` +
      `GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT ON ${id(database)}.* TO ${who}`,
  );
  if (!r.ok) throw new UserError(`Couldn't create the backup user ${username}: ${r.error}`);
  // Stored procedures: SHOW_ROUTINE on MySQL 8.0.20+, SELECT on mysql.proc on MariaDB.
  const routines = (await query(adminFile, `GRANT SHOW_ROUTINE ON *.* TO ${who}`)).ok || (await query(adminFile, `GRANT SELECT ON mysql.proc TO ${who}`)).ok;
  return { username, password, routines };
}
