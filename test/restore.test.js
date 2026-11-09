// Restores with real restic, a stand-in mysqldump, and a stand-in mysql client that
// keeps each "database" as a folder holding the SQL loaded into it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { backupApps } from "../src/backup.js";
import { loadConfig, saveConfig, saveRecoveryKey } from "../src/config.js";
import { paths } from "../src/paths.js";
import { restoreFlow } from "../src/flows/restore.js";
import { app } from "../src/app.js";
import { findPhp } from "../src/laravel.js";
import { describeFound } from "../src/flows/adopt.js";
import { dumpFilter } from "../src/dump.js";
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
  assert.deepEqual(await scratchDatabases(), [], "no throwaway database left");
  assert.equal((await readFile(join(dir, "storage/app/private/invoices/88.pdf"))).length, 500, "deleted file is back");
  assert.equal(existsSync(join(dir, "storage/app/public/stray.txt")), false, "files added since are removed");
  assert.match(await readFile(join(dir, "app.php"), "utf8"), /never touched/, "the app's code is outside the restored folders");
  assert.ok(existsSync(join(dir, "storage/logs")), "nor are folders that weren't backed up");

  // The safety point holds the state from just before: the stray file and the old database.
  const env = await resticEnv(config, p);
  const points = await listPoints("shop", { bin: restic, env });
  const safety = points.find((pt) => pt.id === r.safety.point);
  assert.equal(safety.safety, true);
  const state = JSON.parse(await readFile(join(p.dataDir, "state.json"), "utf8"));
  assert.notEqual(state.projects.shop.lastBackup.point, safety.id, "the status doesn't count the safety point as a backup");
  assert.notEqual(state.projects.shop.lastSuccess.point, safety.id);
  assert.equal(state.projects.shop.replacing, undefined, "a replace that finished leaves no warning");
  const undo = await restoreApp({ app: "shop", point: safety.id, mode: "replace" }, { p });
  assert.equal(undo.ok, true);
  assert.equal(await liveSql(), DUMP); // the stand-in dump is fixed; files tell the difference:
  assert.equal(await readFile(join(dir, "storage/app/public/stray.txt"), "utf8"), "added after the backup", "undo works");
});

test("an unfinished replace is remembered: the home screen warns, backups are flagged, and Put back repairs it", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await setup();
  // The trial load works; the live one dies halfway (MySQL crashed, the server went down).
  process.env.FAKE_LOAD_FAIL_DB = "shop_prod";
  let r;
  try {
    r = await restoreApp({ app: "shop", parts: ["database"], mode: "replace" }, { p });
  } finally {
    delete process.env.FAKE_LOAD_FAIL_DB;
  }
  assert.equal(r.ok, false);
  assert.match(await liveSql(), /half/, "the live database is half there");
  const state = JSON.parse(await readFile(join(p.dataDir, "state.json"), "utf8"));
  assert.equal(state.projects.shop.replacing.safety, r.safety.point);
  assert.deepEqual(state.projects.shop.replacing.parts, ["database"]);

  const [b] = await backupApps([], { p });
  assert.match(b.halfRestored, /A replace from the backup of .* didn't finish .*, so this backup may hold half-restored data/);

  const ask = scripted([
    ["select", /What do you want to do/, (o) => (assert.equal(o.choices[0].value, "unfinished", "first in the menu"), "unfinished")],
    ["select", /shop: A replace .* didn't finish.*What now/, (o) => (assert.ok(o.choices.find((c) => c.value === "again")), "back")],
    ["confirm", /Replace shop's live database with the state from before/, true],
    ["confirm", /Clear the app's Laravel cache now/, false], // a repair is a replace too (#14)
    ["select", /What do you want to do/, (o) => (assert.equal(o.choices.find((c) => c.value === "unfinished"), undefined, "repaired: gone"), "quit")],
  ]);
  const out = await captured(() => app({ ask, p }));
  assert.deepEqual(ask.remaining, []);
  assert.match(out, /⚠ shop: A replace from the backup of .* didn't finish .*\. The live database may be incomplete\./);
  // (The stand-in mysqldump always prints the same dump, so the safety point holds that.)
  assert.equal(await liveSql(), DUMP, "complete again: the half-loaded table is gone");
  assert.equal(JSON.parse(await readFile(join(p.dataDir, "state.json"), "utf8")).projects.shop.replacing, undefined);
});

test("replace stops before touching anything if the current state can't be saved", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir } = await setup();
  await rm(join(dir, "storage/app/public"), { recursive: true }); // backup of files will fail: folder missing
  await assert.rejects(restoreApp({ app: "shop", mode: "replace" }, { p }), /Couldn't save the current files first, so nothing was replaced/);
  assert.equal(await liveSql(), "CREATE TABLE `live` (id int);\n");
});

// Damages a data file on the "drive", the way a bad spot would: restic notices when it reads it.
async function damage(file) {
  await chmod(file, 0o644);
  const bytes = await readFile(file);
  for (let i = 0; i < 16; i++) bytes[i] ^= 0xff;
  await writeFile(file, bytes);
}

async function dataFiles(repo) {
  const entries = await readdir(join(repo, "data"), { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

const scratchDatabases = () => readdir(dbDir).then((names) => names.filter((n) => n.includes("agouti_check")));

test("replace from a damaged backup: the live database is untouched, and the real cause is named", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, config } = await setup();
  for (const f of await dataFiles(config.repository)) await damage(f);
  const before = (await listPoints("shop", { bin: restic, env: await resticEnv(config, p) })).length;

  await assert.rejects(restoreApp({ app: "shop", mode: "replace" }, { p }), (err) => {
    assert.match(err.message, /nothing was replaced/i);
    assert.match(err.message, /Reading the backup failed/);
    assert.doesNotMatch(err.message, /SQL syntax/);
    return true;
  });
  assert.equal(await liveSql(), "CREATE TABLE `live` (id int);\n", "live database untouched");
  assert.deepEqual(await scratchDatabases(), [], "no throwaway database left");
  const after = (await listPoints("shop", { bin: restic, env: await resticEnv(config, p) })).length;
  assert.equal(after, before, "no safety point of a state nothing changed");
});

test("files: a damaged file is named and renamed, and the other folders are still restored", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir, config } = await setup();
  // A large new file in private/, the folder restored first: its data lands in packs of its own.
  const known = new Set(await dataFiles(config.repository));
  // Random (it can't compress) and 20 MB: restic cuts it into pieces of at most 8 MB,
  // so at least 3, spread over at least 2 data files. One damaged spot per data file
  // leaves good pieces, so restic writes the file with wrong contents, as in the rehearsal.
  await writeFile(join(dir, "storage/app/private/big.bin"), randomBytes(20_000_000));
  const [b] = await backupApps([], { p });
  const added = (await dataFiles(config.repository)).filter((f) => !known.has(f));
  assert.ok(added.length >= 1);
  // In the middle of the data, as in the rehearsal: restic then writes the file at full
  // size with wrong contents (damage at the start can mean no file at all).
  for (const f of added) {
    await chmod(f, 0o644);
    const bytes = await readFile(f);
    for (let i = 0; i < 64; i++) bytes[(bytes.length >> 1) + i] ^= 0xff;
    await writeFile(f, bytes);
  }

  const r = await restoreApp({ app: "shop", point: b.point, parts: ["files"], mode: "copy" }, { p });
  assert.equal(r.ok, false);
  assert.deepEqual(r.files.damaged, ["storage/app/private/big.bin"]);
  assert.match(r.files.error, /1 file couldn't be restored because the backup data is damaged: storage\/app\/private\/big\.bin\. Any partial copy was renamed to \*\.damaged/);
  assert.match(r.files.error, /Everything else was restored/);
  assert.match(r.files.hint, /older restore point/);
  const copy = join(p.dataDir, "restores", `shop-${b.point}`, "storage/app");
  assert.equal(existsSync(join(copy, "private/big.bin")), false, "no file with wrong contents under its real name");
  assert.ok(existsSync(join(copy, "private/big.bin.damaged")));
  assert.equal((await readFile(join(copy, "private/invoices/88.pdf"))).length, 500, "the rest of that folder");
  assert.equal((await readFile(join(copy, "public/avatars/1.jpg"))).length, 1500, "the next folder is still restored");

  // A single file: the same, as an error that names it.
  await assert.rejects(restoreFilesByPath("shop", b.point, [join(dir, "storage/app/private/big.bin")], { p }), /The backup data of storage\/app\/private\/big\.bin is damaged in restore point/);
});

test("replace with a dump the server can't load: the live database is untouched", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await setup();
  process.env.FAKE_LOAD_FAIL = "1";
  try {
    await assert.rejects(restoreApp({ app: "shop", mode: "replace" }, { p }), /nothing was replaced.*Loading the dump failed/is);
  } finally {
    delete process.env.FAKE_LOAD_FAIL;
  }
  assert.equal(await liveSql(), "CREATE TABLE `live` (id int);\n");
  assert.deepEqual(await scratchDatabases(), []);
});

test("replace stops when the safety point can't be read back, because undo wouldn't work", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { root, p, config, point } = await setup();

  // A second backup with a different database. Damage its data: the first point stays
  // healthy, but saving this same database again re-uses the damaged data.
  const newer = join(root, "newer.sql");
  await writeFile(newer, `CREATE TABLE \`newer\` (id int);\nINSERT INTO \`newer\` VALUES ${Array.from({ length: 40000 }, (_, i) => `(${i * 7919})`).join(",")};\n`);
  process.env.FAKE_DUMP = newer;
  try {
    const known = new Set(await dataFiles(config.repository));
    await backupApps([], { p });
    const added = (await dataFiles(config.repository)).filter((f) => !known.has(f));
    const sizes = await Promise.all(added.map(async (f) => [(await stat(f)).size, f]));
    await damage(sizes.sort((a, b) => b[0] - a[0])[0][1]); // the biggest: the dump, not the folder listing

    await assert.rejects(restoreApp({ app: "shop", point, mode: "replace" }, { p }), /can't be read back.*nothing was replaced/is);
  } finally {
    delete process.env.FAKE_DUMP;
  }
  assert.equal(await liveSql(), "CREATE TABLE `live` (id int);\n", "live database untouched");
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
  // A copy left in the folder earlier (a full copy, a previous single file) doesn't count.
  await writeFile(join(p.dataDir, "restores", `shop-${point}`, "nope.txt"), "stale");
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

test("after a replace, a Laravel app's cache is cleared on request, as the app's owner; skipping says what it means", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { root, p, dir } = await setup();
  // A stand-in php: records how artisan was called, or fails when told to.
  const php = join(root, "php");
  const log = join(root, "php.log");
  await writeFile(php, `#!/bin/sh\nif [ -n "$PHP_FAIL" ]; then echo "  In Connection.php: SQLSTATE[HY000] [2002] Connection refused"; exit 1; fi\necho "$PWD $*" >> ${log}\necho "   INFO  Application cache cleared successfully."\n`);
  await chmod(php, 0o755);
  process.env.AGOUTI_PHP = php;
  const replace = (answer) =>
    scripted([
      ["select", /Which restore point/, (o) => o.choices[0].value],
      ["select", /What do you want to restore/, "database"],
      ["select", /How\?/, "replace"],
      ["input", /Type .*shop.* to confirm/, "shop"],
      ["confirm", /Clear the app's Laravel cache now/, (o) => (assert.equal(o.default, true), answer)],
    ]);
  try {
    let ask = replace(true);
    let out = await captured(() => restoreFlow(ask, { p }));
    assert.deepEqual(ask.remaining, []);
    assert.match(out, /✓ Laravel's cache cleared \(as /);
    assert.match(out, /✓ Current state saved[^\n]*\nReplacing the live database\.\.\./, "live data starts changing here, and says so (#44)");
    assert.equal((await readFile(log, "utf8")).trim(), `${dir} artisan cache:clear --no-interaction`, "in the app's folder");
    assert.doesNotMatch(out, /Clear the app's caches if it has any/, "no leftover hint");

    ask = replace(false);
    out = await captured(() => restoreFlow(ask, { p }));
    assert.match(out, /may show data from before the restore/);

    process.env.PHP_FAIL = "1";
    ask = replace(true);
    out = await captured(() => restoreFlow(ask, { p }));
    assert.match(out, /Couldn't clear the cache: In Connection\.php: SQLSTATE\[HY000\] \[2002\] Connection refused\. Until it's cleared/);
  } finally {
    delete process.env.AGOUTI_PHP;
    delete process.env.PHP_FAIL;
  }
});

test("php is found where sudo's PATH doesn't look: in the app owner's home (Laravel Herd)", async () => {
  const home = await mkdtemp(join(tmpdir(), "agouti-home-"));
  const sudoPath = "/nonexistent/sbin:/nonexistent/bin";
  assert.equal(await findPhp(home, { path: sudoPath }).then((x) => (x?.startsWith(home) ? x : null)), null, "nothing in that home yet");
  await mkdir(join(home, ".config/herd-lite/bin"), { recursive: true });
  await writeFile(join(home, ".config/herd-lite/bin/php"), "#!/bin/sh\n");
  await chmod(join(home, ".config/herd-lite/bin/php"), 0o755);
  assert.equal(await findPhp(home, { path: sudoPath }), join(home, ".config/herd-lite/bin/php"));
});

test("single files with awkward names: not valid UTF-8 (Latin-1), and pattern characters", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir } = await setup();
  const folder = join(dir, "storage/app/private");
  const latin1 = Buffer.concat([Buffer.from(`${folder}/caf`), Buffer.from([0xe9]), Buffer.from(".pdf")]);
  await writeFile(latin1, "latin1 content");
  await writeFile(join(folder, "rapport[1].pdf"), "bracket content");
  await writeFile(join(folder, "rapport1.pdf"), "a different file");
  const [b] = await backupApps([], { p });

  // As the search lists it: the byte that isn't UTF-8 became U+FFFD.
  const [restored] = await restoreFilesByPath("shop", b.point, [`${folder}/caf\uFFFD.pdf`], { p });
  assert.ok(Buffer.isBuffer(restored), "the real name, byte for byte");
  assert.equal(await readFile(restored, "utf8"), "latin1 content");
  const [bracket] = await restoreFilesByPath("shop", b.point, [join(folder, "rapport[1].pdf")], { p });
  assert.equal(await readFile(bracket, "utf8"), "bracket content");

  // The hint to put it back names those exact bytes.
  const { shellQuote } = await import("../src/ui.js");
  assert.deepEqual(spawnSync("bash", ["-c", `printf %s ${shellQuote(restored)}`]).stdout, restored);
});

test("new server: a wrong suggestion can be corrected at the summary, before anything is restored", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const old = await setup();
  const { root, p } = await newServer(old);
  const wrong = join(root, "srv/old-path");
  const right = join(root, "srv/shop");
  for (const d of [wrong, right]) {
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "artisan"), "");
  }
  const ask = scripted([
    ["input", /Where should shop go/, (o) => (assert.equal(o.default, old.dir), wrong)], // Enter on a wrong answer
    ["input", /Database name/, (o) => (assert.equal(o.default, "shop_prod"), "shop_prod")],
    ["select", /Go ahead/, "dir"],
    ["input", /Where should shop go/, (o) => (assert.equal(o.default, wrong, "starts from the answer given"), right)],
    ["select", /Go ahead/, "db"],
    ["input", /Database name/, (o) => (assert.equal(o.default, "shop_prod"), "shop_new")],
    ["select", /Go ahead/, "go"],
    ["confirm", /Keep backing up shop/, false],
  ]);
  const out = await captured(() => restoreFlow(ask, { p }));
  assert.deepEqual(ask.remaining, []);
  assert.match(out, /restored into shop_new/);
  assert.equal((await readFile(join(right, "storage/app/private/invoices/88.pdf"))).length, 500, "into the corrected folder");
  assert.equal(existsSync(join(wrong, "storage/app/private")), false, "nothing in the first answer's folder");
  assert.equal(existsSync(join(dbDir, "shop_prod")), true, "the old name's database (there already) untouched");
});

test("backup counts after a replace and after deletions say what really happened", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir } = await setup();
  await restoreApp({ app: "shop", parts: ["files"], mode: "replace" }, { p });
  const { runBackup } = await import("../src/flows/backup.js");
  let out = await captured(() => runBackup([], { p, live: false }));
  assert.match(out, /"Changed" includes every file the last replace rewrote/, "explained once, after the replace (#13)");
  out = await captured(() => runBackup([], { p, live: false }));
  assert.doesNotMatch(out, /last replace rewrote/, "not on later backups");

  await rm(join(dir, "storage/app/private/invoices/88.pdf"));
  out = await captured(() => runBackup([], { p, live: false }));
  assert.match(out, /✓ files +1 file · .* · 1 removed ·/, "a deletion isn't \"no changes\" (#30)");

});

test("a replace that brings back a file deleted since the last backup: 1 new, nothing removed", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  // As on 2026-11-08: backup (2 files), a file deleted with no backup after it, then a
  // replace from that backup, then a backup. The safety point (1 file) is restic's
  // parent; counting "removed" against the older backup (2 files) invented one.
  const { p, dir, point } = await setup();
  await rm(join(dir, "storage/app/private/invoices/88.pdf"));
  await restoreApp({ app: "shop", point, parts: ["files"], mode: "replace" }, { p });
  const { runBackup } = await import("../src/flows/backup.js");
  const out = await captured(() => runBackup([], { p, live: false }));
  assert.match(out, /✓ files +2 files · .* · 1 new(, \d+ changed)? · /);
  assert.doesNotMatch(out, /removed/);
});

test("a sparse file is restored sparse, not at its full size", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir } = await setup();
  const file = join(dir, "storage/app/private/disk.img");
  const fh = await open(file, "w");
  await fh.truncate(64 * 1024 * 1024); // 64 MB, all hole
  await fh.write(Buffer.from("data at the start"), 0, 17, 0);
  await fh.close();
  const [b] = await backupApps([], { p });
  await restoreApp({ app: "shop", point: b.point, parts: ["files"], mode: "copy" }, { p });
  const restored = join(p.dataDir, "restores", `shop-${b.point}`, "storage/app/private/disk.img");
  const s = await stat(restored);
  assert.equal(s.size, 64 * 1024 * 1024);
  assert.ok(s.blocks * 512 < 4 * 1024 * 1024, `takes ${s.blocks * 512} bytes on disk, not 64 MB`);
  assert.equal((await readFile(restored)).subarray(0, 17).toString(), "data at the start");
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
    ["select", /Go ahead/, (o) => (assert.equal(o.default, "go"), "go")],
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

test("new server: folders Agouti creates get the owner and permissions recorded in the backup", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const old = await setup();
  await chmod(join(old.dir, "storage/app/private"), 0o2770); // setgid, group-writable: a shared upload folder
  await chmod(join(old.dir, "storage/app"), 0o750);
  const [b] = await backupApps([], { p: old.p });
  await chmod(join(old.dir, "storage/app"), 0o755);

  const { root, p } = await newServer(old);
  const dir = join(root, "srv/shop");
  await mkdir(join(dir, "storage"), { recursive: true });
  await chmod(join(dir, "storage"), 0o700); // already there: not ours to change
  const project = { path: dir, database: { engine: "mysql", name: "shop_new", host: "localhost", port: 3306 }, files: old.config.projects.shop.files };
  const r = await restoreApp({ app: "shop", mode: "new", project, origin: old.dir, point: b.point }, { p });
  assert.equal(r.ok, true);

  const mode = async (rel) => (await stat(join(dir, rel))).mode & 0o7777;
  assert.equal(await mode("storage/app/private"), 0o2770, "the restored folder");
  assert.equal(await mode("storage/app"), 0o750, "a parent folder Agouti had to create");
  assert.equal((await stat(join(dir, "storage/app/private"))).uid, process.getuid(), "the recorded owner (chown needs root; here it's us)");
  assert.equal(await mode("storage"), 0o700, "a folder that already existed is left alone");
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

// Point ids have one-second resolution: two points in the same second would merge.
const nextSecond = () => new Promise((r) => setTimeout(r, 1100));

// The old server's history: a good backup, a replace (its safety point), then a
// backup whose database failed. Newest first: incomplete, safety, good.
async function messyHistory() {
  const old = await setup();
  await nextSecond();
  const r = await restoreApp({ app: "shop", mode: "replace" }, { p: old.p });
  await nextSecond();
  process.env.FAKE_DUMP = join(old.root, "no-such-dump.sql"); // mysqldump fails
  try {
    const [bad] = await backupApps(["shop"], { p: old.p });
    assert.equal(bad.ok, false);
  } finally {
    delete process.env.FAKE_DUMP;
  }
  const points = await listPoints("shop", { bin: restic, env: await resticEnv(old.config, old.p) });
  assert.deepEqual(
    points.map((pt) => [!!pt.database, !!pt.files, pt.safety]),
    [[false, true, false], [true, true, true], [true, true, false]],
  );
  return { old, good: old.point, safety: r.safety.point, incomplete: points[0].id };
}

test("latest means the newest real backup with the parts asked for: not a safety point, not an incomplete one", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { old, good, incomplete } = await messyHistory();
  const both = await restoreApp({ app: "shop", point: "latest", mode: "copy" }, { p: old.p });
  assert.equal(both.point, good, "the incomplete point and the safety point are passed over");
  const files = await restoreApp({ app: "shop", point: "latest", parts: ["files"], mode: "copy" }, { p: old.p });
  assert.equal(files.point, incomplete, "for files alone, the newest point that has them");
  const [single] = await restoreFilesByPath("shop", "latest", [join(old.dir, "storage/app/private/invoices/88.pdf")], { p: old.p });
  assert.ok(single.includes(`shop-${incomplete}`), "a single file: from the newest point that has files");
});

test("new server: suggests the newest complete backup, and can't pick an incomplete point", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { old, good, safety, incomplete } = await messyHistory();
  const { root, p } = await newServer(old);
  const dir = join(root, "srv/shop");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "artisan"), "");

  const ask = scripted([
    [
      "select",
      /Which restore point/,
      (o) => {
        assert.equal(o.default.id, good);
        const choice = (id) => o.choices.find((c) => c.value.id === id);
        assert.match(choice(incomplete).disabled, /no database/);
        assert.equal(choice(good).disabled, false);
        assert.match(choice(good).name, /latest/);
        assert.match(choice(safety).name, /saved before a restore/);
        assert.doesNotMatch(choice(safety).name, /latest/);
        return o.default;
      },
    ],
    ["input", /Where should shop go/, dir],
    ["input", /Database name/, "shop_new"],
    ["select", /Go ahead/, (o) => (assert.equal(o.default, "go"), "go")],
    ["confirm", /Keep backing up shop/, false],
  ]);
  const out = await captured(() => restoreFlow(ask, { p }));
  assert.deepEqual(ask.remaining, []);
  assert.match(out, /The newest restore point isn't a complete backup/);
  const [found] = await discoverApps({ bin: restic, env: await resticEnv(old.config, p) });
  assert.match(describeFound(found), /last complete backup .* \(a newer one is incomplete\)/, "an incomplete backup isn't called the last one");
  assert.match(out, new RegExp(`restore shop as it was on`));
  assert.match(out, /✓ database  restored into shop_new/);
  assert.equal((await readFile(join(dir, "storage/app/private/invoices/88.pdf"))).length, 500);
});

test("new server: when no backup is complete, says so instead of failing halfway", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const old = await setup();
  const env = await resticEnv(old.config, old.p);
  const [db] = JSON.parse(spawnSync(restic, ["snapshots", "--json", "--tag", "part=database"], { env, encoding: "utf8" }).stdout);
  spawnSync(restic, ["forget", db.id], { env });
  const { p } = await newServer(old);
  await assert.rejects(restoreFlow(scripted([]), { p }), /No backup of shop has database and files/);
});

test("agouti connect lists the apps found in the backups", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const old = await setup();
  const root = await mkdtemp(join(tmpdir(), "agouti-connect-"));
  const env = { ...process.env, AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var"), NO_COLOR: "1" };
  const r = spawnSync(process.execPath, [BIN, "connect", old.config.repository, "--recovery-key", "agouti-rk-TEST"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Found 1 app in the backups:\n  shop .* database shop_prod · last complete backup just now/);
  // "sudo agouti", or the full command where sudo can't find agouti (#11), as here and in CI.
  assert.match(r.stdout, /sudo (agouti|\S+ \S+\/bin\/agouti\.js) → Restore/);
});

test("a throwaway database never gets the dump's events, in the form mysqldump writes them", async () => {
  const lines = [
    "CREATE TABLE `a` (id int);",
    "DELIMITER ;;",
    "/*!50003 SET time_zone = 'SYSTEM' */ ;;",
    "/*!50106 CREATE*/ /*!50117 DEFINER=`root`@`localhost`*/ /*!50106 EVENT `purge` ON SCHEDULE EVERY 1 DAY DO",
    "DELETE FROM live_db.logs */ ;;",
    "/*!50003 SET time_zone = @saved_time_zone */ ;;",
    "DELIMITER ;",
  ];
  const run = (filter) => lines.map((l) => filter.line(l)).join("");

  const kept = dumpFilter();
  assert.match(run(kept), /EVENT `purge`/);
  assert.equal(kept.stats.events, 1);

  const skipped = dumpFilter({ skipEvents: true });
  const out = run(skipped);
  assert.doesNotMatch(out, /EVENT `purge`|live_db/);
  assert.match(out, /SET time_zone = @saved_time_zone/, "the rest of the block stays");
  assert.deepEqual([skipped.stats.events, skipped.stats.skipped.events], [1, 1]);
});
