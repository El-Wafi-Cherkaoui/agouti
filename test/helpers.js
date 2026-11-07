// Shared test helpers: scripted prompt answers and output capture.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each step: [kind, message regexp, answer]. The answer may be a function of the
// prompt options, to inspect what was offered.
export function scripted(steps) {
  const take = (kind) => async (opts) => {
    const step = steps.shift();
    assert.ok(step, `unexpected ${kind} prompt: "${opts.message}"`);
    assert.equal(kind, step[0], `expected a ${step[0]} prompt, got ${kind}: "${opts.message}"`);
    assert.match(opts.message, step[1]);
    return typeof step[2] === "function" ? step[2](opts) : step[2];
  };
  return {
    select: take("select"),
    input: take("input"),
    password: take("password"),
    confirm: take("confirm"),
    checkbox: take("checkbox"),
    remaining: steps,
  };
}

// Collects what the code under test prints.
export async function captured(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

// A .env with database settings next to secrets that must never leak.
export const ENV = `
APP_NAME=Shop
APP_KEY=base64:SUPERSECRETAPPKEY=
STRIPE_SECRET=sk_live_dont_touch
export DB_CONNECTION=mysql
DB_HOST=127.0.0.1   # local
DB_PORT=3307
DB_DATABASE="shop_prod"
DB_USERNAME='shop'
DB_PASSWORD="p\\"a#ss word"
MAIL_PASSWORD=also-secret
`;

// A minimal Laravel 11 app with uploads, logs and caches.
export async function laravelFixture() {
  const dir = await mkdtemp(join(tmpdir(), "agouti-laravel-"));
  await writeFile(join(dir, "artisan"), "#!/usr/bin/env php\n");
  await writeFile(join(dir, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^11.0" } }));
  await writeFile(join(dir, "composer.lock"), JSON.stringify({ packages: [{ name: "laravel/framework", version: "v11.31.0" }] }));
  for (const d of ["storage/app/public/avatars", "storage/app/private/invoices", "storage/logs", "storage/framework/cache", "bootstrap/cache"]) {
    await mkdir(join(dir, d), { recursive: true });
  }
  await writeFile(join(dir, "storage/app/public/avatars/1.jpg"), Buffer.alloc(1500));
  await writeFile(join(dir, "storage/app/private/invoices/88.pdf"), Buffer.alloc(500));
  await writeFile(join(dir, "storage/logs/laravel.log"), "log");
  await writeFile(join(dir, ".env"), ENV);
  return dir;
}

// The dump the stand-in mysqldump prints (unless FAKE_DUMP names a file to print).
export const FAKE_DUMP = "-- fake dump\nCREATE TABLE `users` (id int);\nINSERT INTO `users` VALUES (1);\nCREATE TABLE `orders` (id int);\n";

// Stand-ins for mysqldump and mysql. The mysql one keeps each database as a folder
// under FAKE_MYSQL_DATA holding the SQL loaded into it, and behaves like a MySQL
// with binary logging on (FAKE_LOG_BIN=0 to turn it off) towards restricted users:
// agouti_verify can't load other users' DEFINERs, nor triggers and functions.
export async function installFakeMysql() {
  const dir = await mkdtemp(join(tmpdir(), "agouti-fakemysql-"));
  const dump = join(dir, "default.sql");
  await writeFile(dump, FAKE_DUMP);
  await writeFile(join(dir, "mysqldump"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "mysqldump  Ver 8.4"; exit 0; fi\ncat "\${FAKE_DUMP:-${dump}}"\n`);
  await writeFile(
    join(dir, "mysql"),
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const DATA = process.env.FAKE_MYSQL_DATA;
const logBin = process.env.FAKE_LOG_BIN ?? "1";
const cnf = fs.readFileSync(args[0].replace("--defaults-extra-file=", ""), "utf8");
if (cnf.includes('password="wrong"')) { console.error("ERROR 1045 (28000): Access denied for user 'root'@'localhost'"); process.exit(1); }
const restricted = cnf.includes('user="agouti_verify"');
const e = args.indexOf("-e");
const db = (name) => path.join(DATA, name);
const data = (name) => { const f = path.join(db(name), "data.sql"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""; };
const tables = (name) => [...data(name).matchAll(/^CREATE TABLE \`([^\`]+)\`/gm)].map((m) => m[1]);
const rows = (name, t) => data(name).split("\\n").filter((l) => l.startsWith("INSERT INTO \`" + t + "\`")).reduce((n, l) => n + l.split("),(").length, 0);
if (e === -1) {
  const target = args.at(-1);
  if (!fs.existsSync(db(target))) { console.error("ERROR 1049 (42000): Unknown database '" + target + "'"); process.exit(1); }
  const sql = fs.readFileSync(0, "utf8");
  if (process.env.FAKE_LOAD_FAIL) { console.error("ERROR 1064 (42000) at line 2: You have an error in your SQL syntax"); process.exit(1); }
  if (process.env.FAKE_LOAD_FAIL_DB === target) { fs.writeFileSync(path.join(db(target), "data.sql"), "CREATE TABLE \`half\` (id int);\\n"); console.error("ERROR 2013 (HY000) at line 900: Lost connection to MySQL server during query"); process.exit(1); }
  if (restricted && /^(?!INSERT).*DEFINER=\`/m.test(sql)) { console.error("ERROR 1227 (42000) at line 9: Access denied; you need (at least one of) the SUPER or SET_USER_ID privilege(s) for this operation"); process.exit(1); }
  if (restricted && logBin === "1" && /TRIGGER \`|^CREATE\\s+FUNCTION/m.test(sql)) { console.error("ERROR 1419 (HY000) at line 20: You do not have the SUPER privilege and binary logging is enabled"); process.exit(1); }
  fs.writeFileSync(path.join(db(target), "data.sql"), sql);
  process.exit(0);
}
const sql = args[e + 1];
const name = (re) => (sql.match(re) || [])[1];
if (/CURRENT_USER/.test(sql)) console.log("root@localhost");
else if (/@@log_bin/.test(sql)) console.log(logBin + "\\t0");
else if (/DEFAULT_CHARACTER_SET_NAME/.test(sql)) { const n = name(/SCHEMA_NAME = '([^']+)'/); if (fs.existsSync(db(n))) console.log("utf8mb4\\tutf8mb4_unicode_ci"); }
else if (/SELECT 1 FROM information_schema.SCHEMATA/.test(sql)) { if (fs.existsSync(db(name(/SCHEMA_NAME = '([^']+)'/)))) console.log(1); }
else if (/SELECT TABLE_NAME FROM information_schema.TABLES/.test(sql)) tables(name(/TABLE_SCHEMA = '([^']+)'/)).forEach((t) => console.log(t));
else if (/information_schema.TABLES/.test(sql)) console.log(tables(name(/TABLE_SCHEMA = '([^']+)'/)).length);
else if (/COUNT\\(\\*\\) FROM \`/.test(sql)) for (const m of sql.matchAll(/SELECT '([^']+)', COUNT\\(\\*\\) FROM \`([^\`]+)\`/g)) console.log(m[1] + "\\t" + rows(m[2], m[1]));
else if (/^SELECT 1$/.test(sql)) console.log(1);
else {
  const drop = name(/DROP DATABASE IF EXISTS \`([^\`]+)\`/); if (drop) fs.rmSync(db(drop), { recursive: true, force: true });
  const create = name(/CREATE DATABASE (?:IF NOT EXISTS )?\`([^\`]+)\`/); if (create) fs.mkdirSync(db(create), { recursive: true });
}
`,
  );
  await chmod(join(dir, "mysqldump"), 0o755);
  await chmod(join(dir, "mysql"), 0o755);
  process.env.AGOUTI_MYSQLDUMP = join(dir, "mysqldump");
  process.env.AGOUTI_MYSQL = join(dir, "mysql");
  return dir;
}
