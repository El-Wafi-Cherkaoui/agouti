// Restores with real restic, a stand-in mysqldump, and a stand-in mysql client that
// keeps each "database" as a folder holding the SQL loaded into it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { backupApps } from "../src/backup.js";
import { saveConfig, saveRecoveryKey } from "../src/config.js";
import { paths } from "../src/paths.js";
import { restoreFlow } from "../src/flows/restore.js";
import { applyRetention } from "../src/retention.js";
import { copyDatabaseName, listPoints, restoreApp, restoreFilesByPath } from "../src/restore.js";
import { ensureRestic, resticEnv } from "../src/restic.js";
import { captured, laravelFixture, scripted } from "./helpers.js";

const CACHE = fileURLToPath(new URL("./.cache", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/agouti.js", import.meta.url));
const DUMP = "-- fake dump\nCREATE TABLE `users` (id int);\nINSERT INTO `users` VALUES (1);\nCREATE TABLE `orders` (id int);\n";
let restic;
let dbDir; // the stand-in MySQL server's data

before(async () => {
  try {
    restic = await ensureRestic({ p: paths({ AGOUTI_DATA_DIR: CACHE }) });
    process.env.AGOUTI_RESTIC = restic;
  } catch (err) {
    console.warn(`skipping restore tests: ${err.message}`);
  }
  const dir = await mkdtemp(join(tmpdir(), "agouti-fakemysql-"));
  await writeFile(join(dir, "mysqldump"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "mysqldump  Ver 8.4"; exit 0; fi\nprintf '%s' '${DUMP}'\n`);
  await chmod(join(dir, "mysqldump"), 0o755);
  process.env.AGOUTI_MYSQLDUMP = join(dir, "mysqldump");

  // mysql: -e SQL runs a statement; without -e, loads stdin into the database named last.
  await writeFile(
    join(dir, "mysql"),
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const DATA = process.env.FAKE_MYSQL_DATA;
const cnf = fs.readFileSync(args[0].replace("--defaults-extra-file=", ""), "utf8");
if (cnf.includes('password="wrong"')) { console.error("ERROR 1045 (28000): Access denied for user 'root'@'localhost'"); process.exit(1); }
const e = args.indexOf("-e");
const db = (name) => path.join(DATA, name);
if (e === -1) {
  const target = args.at(-1);
  if (!fs.existsSync(db(target))) { console.error("ERROR 1049 (42000): Unknown database '" + target + "'"); process.exit(1); }
  const sql = fs.readFileSync(0, "utf8");
  if (process.env.FAKE_LOAD_FAIL) { console.error("ERROR 1064 (42000) at line 2: You have an error in your SQL syntax"); process.exit(1); }
  fs.writeFileSync(path.join(db(target), "data.sql"), sql);
  process.exit(0);
}
const sql = args[e + 1];
const name = (re) => (sql.match(re) || [])[1];
if (/CURRENT_USER/.test(sql)) console.log("root@localhost");
else if (/DEFAULT_CHARACTER_SET_NAME/.test(sql)) { const n = name(/SCHEMA_NAME = '([^']+)'/); if (fs.existsSync(db(n))) console.log("utf8mb4\\tutf8mb4_unicode_ci"); }
else if (/SELECT 1 FROM information_schema.SCHEMATA/.test(sql)) { if (fs.existsSync(db(name(/SCHEMA_NAME = '([^']+)'/)))) console.log(1); }
else if (/information_schema.TABLES/.test(sql)) { const f = path.join(db(name(/TABLE_SCHEMA = '([^']+)'/)), "data.sql"); console.log(fs.existsSync(f) ? (fs.readFileSync(f, "utf8").match(/^CREATE TABLE \`/gm) || []).length : 0); }
else {
  const drop = name(/DROP DATABASE IF EXISTS \`([^\`]+)\`/); if (drop) fs.rmSync(db(drop), { recursive: true, force: true });
  const create = name(/CREATE DATABASE \`([^\`]+)\`/); if (create) fs.mkdirSync(db(create));
}
`,
  );
  await chmod(join(dir, "mysql"), 0o755);
  process.env.AGOUTI_MYSQL = join(dir, "mysql");
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agouti-restore-"));
  const p = paths({ AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") });
  dbDir = join(root, "mysql-data");
  process.env.FAKE_MYSQL_DATA = dbDir;
  await rm(dbDir, { recursive: true, force: true });
  await mkdir(join(dbDir, "shop_prod"), { recursive: true });
  await writeFile(join(dbDir, "shop_prod", "data.sql"), "CREATE TABLE `live` (id int);\n");
  const repo = join(root, "repo");
  await saveRecoveryKey("agouti-rk-TEST", p);
  spawnSync(restic, ["init", "-r", repo, "--password-file", p.recoveryKey]);
  const dir = await laravelFixture();
  await writeFile(join(dir, "app.php"), "<?php // the app's code: never backed up, never touched");
  const project = {
    path: dir,
    framework: "laravel",
    database: { engine: "mysql", name: "shop_prod", host: "127.0.0.1", port: 3306, user: "agouti_backup", credentials: join(root, "shop.cnf") },
    files: ["storage/app/public", "storage/app/private"],
  };
  const config = { repository: repo, projects: { shop: project } };
  await saveConfig(config, p);
  const [point] = await backupApps([], { p });
  return { root, p, dir, config, point: point.point };
}

const liveSql = () => readFile(join(dbDir, "shop_prod", "data.sql"), "utf8");

test("a copy restore touches nothing live, and never overwrites an earlier copy", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir, point } = await setup();
  await rm(join(dir, "storage/app/private/invoices/88.pdf"));

  const r = await restoreApp({ app: "shop" }, { p });
  assert.equal(r.ok, true);
  const copy = copyDatabaseName("shop_prod", point);
  assert.equal(r.database.database, copy);
  assert.equal(await readFile(join(dbDir, copy, "data.sql"), "utf8"), DUMP, "the dump is loaded as-is");
  assert.deepEqual([r.database.tables, r.database.expectedTables], [2, 2]);
  assert.equal(await liveSql(), "CREATE TABLE `live` (id int);\n", "live database untouched");

  // Laid out like the app, so paths are familiar.
  assert.equal(r.files.path, join(p.dataDir, "restores", `shop-${point}`));
  assert.equal((await readFile(join(r.files.path, "storage/app/private/invoices/88.pdf"))).length, 500);
  assert.equal(existsSync(join(dir, "storage/app/private/invoices/88.pdf")), false, "live files untouched");

  await assert.rejects(restoreApp({ app: "shop" }, { p }), /already exists \(restored earlier\?\)/);
  await rm(r.files.path, { recursive: true });
  await assert.rejects(restoreApp({ app: "shop" }, { p }), /database shop_prod_restored_\d{8}_\d{4} already exists/);
  assert.deepEqual(await readdir(join(p.dataDir, "restores")), [], "a refused restore does no work at all");
});

test("a failed load doesn't leave a half copy behind", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, point } = await setup();
  process.env.FAKE_LOAD_FAIL = "1";
  let r;
  try {
    r = await restoreApp({ app: "shop", parts: ["database"] }, { p });
  } finally {
    delete process.env.FAKE_LOAD_FAIL;
  }
  assert.equal(r.ok, false);
  assert.match(r.database.error, /Loading the dump failed: .*error in your SQL syntax/);
  assert.equal(existsSync(join(dbDir, copyDatabaseName("shop_prod", point))), false);
});

test("replace: saves the current state first, then makes the backed-up folders identical, and only them", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir, config } = await setup();
  await rm(join(dir, "storage/app/private/invoices/88.pdf"));
  await writeFile(join(dir, "storage/app/public/stray.txt"), "added after the backup");

  const r = await restoreApp({ app: "shop", mode: "replace" }, { p });
  assert.equal(r.ok, true);
  assert.equal(await liveSql(), DUMP, "live database replaced");
  assert.equal((await readFile(join(dir, "storage/app/private/invoices/88.pdf"))).length, 500, "deleted file is back");
  assert.equal(existsSync(join(dir, "storage/app/public/stray.txt")), false, "files added since are removed");
  assert.match(await readFile(join(dir, "app.php"), "utf8"), /never touched/, "the app's code is outside the restored folders");
  assert.ok(existsSync(join(dir, "storage/logs")), "nor are folders that weren't backed up");

  // The safety point holds the state from just before: the stray file and the old database.
  const env = await resticEnv(config, p);
  const points = await listPoints("shop", { bin: restic, env });
  const safety = points.find((pt) => pt.id === r.safety.point);
  assert.equal(safety.safety, true);
  const undo = await restoreApp({ app: "shop", point: safety.id, mode: "replace" }, { p });
  assert.equal(undo.ok, true);
  assert.equal(await liveSql(), DUMP); // the stand-in dump is fixed; files tell the difference:
  assert.equal(await readFile(join(dir, "storage/app/public/stray.txt"), "utf8"), "added after the backup", "undo works");
});

test("replace stops before touching anything if the current state can't be saved", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir } = await setup();
  await rm(join(dir, "storage/app/public"), { recursive: true }); // backup of files will fail: folder missing
  await assert.rejects(restoreApp({ app: "shop", mode: "replace" }, { p }), /Couldn't save the current files first, so nothing was replaced/);
  assert.equal(await liveSql(), "CREATE TABLE `live` (id int);\n");
});

test("no admin connection: fails before any work, and leaves no password file", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await setup();
  await writeFile(join(p.dataDir, "restore-admin-999999.cnf"), "[client]\npassword=left-by-a-killed-run\n");
  await assert.rejects(restoreApp({ app: "shop", admin: { user: "root", password: "wrong" } }, { p }), /Can't connect as root: ERROR 1045/);
  assert.deepEqual(
    (await readdir(p.dataDir)).filter((f) => f.includes("restore-admin")),
    [],
  );
  assert.equal(existsSync(join(p.dataDir, "restores")), false);

  const remote = await setup();
  const config = remote.config;
  config.projects.shop.database.host = "db.internal";
  await saveConfig(config, remote.p);
  await assert.rejects(restoreApp({ app: "shop" }, { p: remote.p }), /on another server \(db\.internal\)/);
});

test("single files are restored next to the app layout; missing ones are reported", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir, point } = await setup();
  const file = join(dir, "storage/app/public/avatars/1.jpg");
  const [restored] = await restoreFilesByPath("shop", "latest", [file], { p });
  assert.equal(restored, join(p.dataDir, "restores", `shop-${point}`, "storage/app/public/avatars/1.jpg"));
  assert.ok(existsSync(restored));
  await assert.rejects(restoreFilesByPath("shop", point, [join(dir, "nope.txt")], { p }), /Not in this restore point/);
});

test("retention never lets a safety point push out a regular backup, and drops it after a week", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, config } = await setup();
  const r = await restoreApp({ app: "shop", parts: ["files"], mode: "replace" }, { p });
  const env = await resticEnv(config, p);
  const policy = { daily: 1, weekly: 0, monthly: 0 };
  const kept = await applyRetention(config, { bin: restic, env, policy });
  assert.deepEqual(kept.apps.shop, { kept: 2, deleted: 0 }, "the regular backup and the safety point");

  const later = await applyRetention(config, { bin: restic, env, policy, now: Date.now() + 8 * 86400000 });
  assert.deepEqual(later.apps.shop, { kept: 1, deleted: 1 });
  const left = await listPoints("shop", { bin: restic, env });
  assert.equal(left.length, 1);
  assert.notEqual(left[0].id, r.safety.point);
});

test("restore from the command line: confirmations for scripts", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, point } = await setup();
  const env = { ...process.env, AGOUTI_CONFIG_DIR: p.configDir, AGOUTI_DATA_DIR: p.dataDir, NO_COLOR: "1" };
  const agouti = (...args) => spawnSync(process.execPath, [BIN, "restore", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  assert.match(agouti("shop", "--list").stdout, new RegExp(`${point}\\s+\\S+ \\S+\\s+database \\+ files`));
  const noYes = agouti("shop", "--replace");
  assert.equal(noYes.status, 1);
  assert.match(noYes.stderr, /--replace overwrites live data. Add --yes/);
  assert.match(agouti().stderr, /Say what to restore/);
  assert.match(agouti("shop", "--only", "logs").stderr, /--only must be database or files/);

  const ok = agouti("shop", "--only", "database");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /✓ database  restored into shop_prod_restored_\d{8}_\d{4} · 2 of 2 tables/);
  assert.match(ok.stdout, /Drop it when you're done: DROP DATABASE `shop_prod_restored_/);
});

test("interactive: a copy by default; replacing needs the app's name typed", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir, point } = await setup();
  const copy = scripted([
    ["select", /Which restore point/, (o) => (assert.match(o.choices[0].name, /database \+ files.*latest/), o.choices[0].value)],
    ["select", /What do you want to restore/, "database"],
    ["select", /How\?/, (o) => (assert.match(o.choices[0].description, /shop_prod_restored_.*Nothing live is touched/), "copy")],
  ]);
  const out = await captured(() => restoreFlow(copy, { p }));
  assert.deepEqual(copy.remaining, []);
  assert.match(out, new RegExp(`restored into ${copyDatabaseName("shop_prod", point)} · 2 of 2 tables`));

  await writeFile(join(dir, "storage/app/public/stray.txt"), "x");
  const cancelled = scripted([
    ["select", /Which restore point/, (o) => o.choices[0].value],
    ["select", /What do you want to restore/, "files"],
    ["select", /How\?/, "replace"],
    ["input", /Type .*shop.* to confirm/, "yes"],
  ]);
  const out2 = await captured(() => restoreFlow(cancelled, { p }));
  assert.match(out2, /Files added since are deleted/);
  assert.match(out2, /Nothing was changed/);
  assert.ok(existsSync(join(dir, "storage/app/public/stray.txt")));
});
