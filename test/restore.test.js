// Restores with real restic, a stand-in mysqldump, and a stand-in mysql client that
// keeps each "database" as a folder holding the SQL loaded into it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { backupApps } from "../src/backup.js";
import { loadConfig, saveConfig, saveRecoveryKey } from "../src/config.js";
import { paths } from "../src/paths.js";
import { restoreFlow } from "../src/flows/restore.js";
import { applyRetention } from "../src/retention.js";
import { copyDatabaseName, discoverApps, listPoints, restoreApp, restoreFilesByPath } from "../src/restore.js";
import { ensureRestic, resticEnv } from "../src/restic.js";
import { FAKE_DUMP, captured, installFakeMysql, laravelFixture, scripted } from "./helpers.js";

const CACHE = fileURLToPath(new URL("./.cache", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/agouti.js", import.meta.url));
const DUMP = FAKE_DUMP;
let restic;
let dbDir; // the stand-in MySQL server's data

before(async () => {
  try {
    restic = await ensureRestic({ p: paths({ AGOUTI_DATA_DIR: CACHE }) });
    process.env.AGOUTI_RESTIC = restic;
  } catch (err) {
    console.warn(`skipping restore tests: ${err.message}`);
  }
  await installFakeMysql();
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

// A second server using the same repository: nothing set up yet.
async function newServer(from) {
  const root = await mkdtemp(join(tmpdir(), "agouti-newserver-"));
  const p = paths({ AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") });
  await saveRecoveryKey("agouti-rk-TEST", p);
  await saveConfig({ repository: from.config.repository, projects: {} }, p);
  return { root, p };
}

test("discovery: a new server finds the apps in the backups, with no credentials", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const old = await setup();
  const { p } = await newServer(old);
  const env = await resticEnv(old.config, p);
  const [found, ...rest] = await discoverApps({ bin: restic, env });
  assert.equal(rest.length, 0);
  assert.equal(found.name, "shop");
  assert.equal(found.points, 1);
  assert.deepEqual(found.description, {
    app: "shop",
    path: old.dir,
    framework: "laravel",
    database: { engine: "mysql", name: "shop_prod", host: "127.0.0.1", port: 3306, user: "agouti_backup" },
    files: ["storage/app/public", "storage/app/private"],
  });

  // Backups made before descriptions existed: worked out from the snapshots.
  const described = JSON.parse(spawnSync(restic, ["snapshots", "--json", "--tag", "part=app"], { env, encoding: "utf8" }).stdout);
  spawnSync(restic, ["forget", described[0].id], { env });
  const [guessed] = await discoverApps({ bin: restic, env });
  assert.equal(guessed.description.guessed, true);
  assert.equal(guessed.description.path, old.dir);
  assert.equal(guessed.description.database.name, "shop_prod");
  assert.deepEqual(guessed.description.files, ["storage/app/private", "storage/app/public"]);
});

test("new server: the app is restored into empty places and set up to be backed up again", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const old = await setup();
  const { root, p } = await newServer(old);
  // The code is deployed already: a fresh clone has .gitignore files in storage/app.
  const dir = join(root, "srv/shop");
  await mkdir(join(dir, "storage/app/public"), { recursive: true });
  await writeFile(join(dir, "storage/app/public/.gitignore"), "*\n");
  await writeFile(join(dir, "artisan"), "");

  const ask = scripted([
    ["input", /Where should shop go/, (o) => (assert.equal(o.default, old.dir), dir)],
    ["input", /Database name/, "shop_new"],
    ["confirm", /Go ahead/, true],
    ["confirm", /Keep backing up shop/, true],
    ["confirm", /daily automatic backups/, false],
  ]);
  const out = await captured(() => restoreFlow(ask, { p })); // the only app: picked without asking
  assert.deepEqual(ask.remaining, []);
  assert.match(out, /✓ database  restored into shop_new · 2 of 2 tables/);
  assert.match(out, /shop is set up on this server \(backup user agouti_shop, read-only\)/);
  assert.doesNotMatch(out, /Deploy shop's code/, "the code is there already");

  assert.equal(await readFile(join(dbDir, "shop_new", "data.sql"), "utf8"), DUMP);
  assert.equal((await readFile(join(dir, "storage/app/private/invoices/88.pdf"))).length, 500);
  const config = await loadConfig(p);
  assert.equal(config.projects.shop.path, dir);
  assert.equal(config.projects.shop.database.name, "shop_new");
  assert.equal(config.projects.shop.database.user, "agouti_shop");
  assert.equal(config.projects.shop.database.source, "restored");
  assert.equal((await stat(config.projects.shop.database.credentials)).mode & 0o777, 0o600);
});

test("new server: never overwrites what's already there", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const old = await setup();
  const { root, p } = await newServer(old);
  const dir = join(root, "srv/shop");
  const project = { path: dir, database: { engine: "mysql", name: "shop_prod", host: "localhost", port: 3306 }, files: old.config.projects.shop.files };
  const opts = { app: "shop", mode: "new", project, origin: old.dir };

  await assert.rejects(restoreApp(opts, { p }), /The database shop_prod already exists on this server and has tables/);
  project.database.name = "shop_other";
  await mkdir(join(dir, "storage/app/private"), { recursive: true });
  await writeFile(join(dir, "storage/app/private/someone-elses.pdf"), "x");
  await assert.rejects(restoreApp(opts, { p }), /storage\/app\/private already has files/);
  assert.equal(existsSync(join(dbDir, "shop_other")), false, "checked before any work");
});

test("agouti connect lists the apps found in the backups", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const old = await setup();
  const root = await mkdtemp(join(tmpdir(), "agouti-connect-"));
  const env = { ...process.env, AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var"), NO_COLOR: "1" };
  const r = spawnSync(process.execPath, [BIN, "connect", old.config.repository, "--recovery-key", "agouti-rk-TEST"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Found 1 app in the backups:\n  shop .* database shop_prod · last backup just now/);
  assert.match(r.stdout, /sudo agouti → Restore/);
});
