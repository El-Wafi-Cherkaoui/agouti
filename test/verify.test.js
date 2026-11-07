// Restore tests: real restic, and the stand-in MySQL from helpers.js, which (like
// MySQL with binary logging on) refuses triggers, functions and other users'
// DEFINERs to the restricted agouti_verify user.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { backupApps } from "../src/backup.js";
import { loadConfig, saveConfig, saveRecoveryKey } from "../src/config.js";
import { dumpFilter } from "../src/dump.js";
import { runBackup, scheduledBackup } from "../src/flows/backup.js";
import { runVerify } from "../src/flows/verify.js";
import { paths } from "../src/paths.js";
import { ensureRestic, resticEnv } from "../src/restic.js";
import { applyRetention } from "../src/retention.js";
import { acceptChange, flaggedChanges, loadState, recordBackup } from "../src/state.js";
import { app } from "../src/app.js";
import { sameServer, setupVerifier, throwawayName, verifyDue } from "../src/verify.js";
import { captured, installFakeMysql, laravelFixture, scripted } from "./helpers.js";

const CACHE = fileURLToPath(new URL("./.cache", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/agouti.js", import.meta.url));
let restic;

// What mysqldump writes for a table with a trigger, a function and a procedure.
const dumpWith = (orders) => `-- MySQL dump
CREATE TABLE \`users\` (id int);
INSERT INTO \`users\` VALUES (1),(2),(3);
CREATE TABLE \`orders\` (id int);
INSERT INTO \`orders\` VALUES ${Array.from({ length: orders }, (_, i) => `(${i})`).join(",")};
INSERT INTO \`orders\` VALUES ('note: DEFINER=\`x\`@\`y\` is data here');
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=\`shop\`@\`%\`*/ /*!50003 TRIGGER \`t_audit\` AFTER INSERT ON \`orders\` FOR EACH ROW BEGIN
  INSERT INTO audit VALUES (NEW.id);
END */;;
DELIMITER ;
DELIMITER ;;
CREATE DEFINER=\`root\`@\`%\` FUNCTION \`vat\`(x DECIMAL(8,2)) RETURNS decimal(8,2)
    DETERMINISTIC
RETURN x * 1.2 ;;
DELIMITER ;
DELIMITER ;;
CREATE DEFINER=\`root\`@\`%\` PROCEDURE \`order_count\`()
SELECT COUNT(*) FROM orders ;;
DELIMITER ;
/*!50001 CREATE VIEW \`big_orders\` AS SELECT 1 AS \`id\`*/;
/*!50001 VIEW \`big_orders\` AS select \`id\` from \`orders\` */;
-- Dump completed
`;

before(async () => {
  try {
    restic = await ensureRestic({ p: paths({ AGOUTI_DATA_DIR: CACHE }) });
    process.env.AGOUTI_RESTIC = restic;
  } catch (err) {
    console.warn(`skipping restore-test tests: ${err.message}`);
  }
  await installFakeMysql();
});

test("the dump filter: definers out, triggers and functions counted but held back, data untouched", () => {
  const f = dumpFilter({ restricted: true, skipBinlogged: true });
  const out = dumpWith(2)
    .split("\n")
    .map((l) => f.line(l))
    .join("");
  assert.deepEqual(f.stats, { tables: 2, views: 1, triggers: 1, functions: 1, procedures: 1, events: 0, skipped: { triggers: 1, functions: 1 } });
  assert.doesNotMatch(out, /TRIGGER|FUNCTION/);
  assert.match(out, /^CREATE {2}PROCEDURE `order_count`\(\)\nSELECT COUNT\(\*\) FROM orders ;;$/m, "procedures kept, definer removed");
  assert.match(out, /DEFINER=`x`@`y` is data here/, "INSERT data is never rewritten");

  // A restore (as an admin) keeps everything as it was.
  const plain = dumpFilter();
  assert.equal(
    dumpWith(2)
      .split("\n")
      .map((l) => plain.line(l))
      .join(""),
    dumpWith(2) + "\n",
  );
});

test("which apps the verify user can test", () => {
  assert.equal(sameServer({ host: "localhost", port: 3306 }, { host: "127.0.0.1", port: 3306 }), true);
  assert.equal(sameServer({ socket: "/run/mysqld/mysqld.sock" }, { host: "127.0.0.1", port: 3306 }), true);
  assert.equal(sameServer({ host: "127.0.0.1", port: 3306 }, { host: "127.0.0.1", port: 3307 }), false);
  assert.equal(sameServer({ host: "localhost" }, { host: "db.internal", port: 3306 }), false);
  assert.equal(throwawayName("my-shop"), "agouti_verify_my_shop");
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agouti-verify-"));
  const p = paths({ AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") });
  process.env.FAKE_MYSQL_DATA = join(root, "mysql-data");
  await mkdir(process.env.FAKE_MYSQL_DATA);
  process.env.FAKE_DUMP = join(root, "dump.sql");
  await writeFile(process.env.FAKE_DUMP, dumpWith(400));
  const repo = join(root, "repo");
  await saveRecoveryKey("agouti-rk-TEST", p);
  spawnSync(restic, ["init", "-r", repo, "--password-file", p.recoveryKey]);
  const dir = await laravelFixture();
  const project = {
    path: dir,
    framework: "laravel",
    database: { engine: "mysql", name: "shop_prod", host: "127.0.0.1", port: 3306, user: "agouti_backup", credentials: join(root, "shop.cnf") },
    files: ["storage/app/public", "storage/app/private"],
  };
  await saveConfig({ repository: repo, projects: { shop: project } }, p);
  return { root, p, dir, repo };
}

// A restic backup holding its lock on the repository. Killed (as by a reboot or
// kill -9), it leaves a stale lock behind, as in the rehearsal; alive, a live one.
async function lockHolder(repo, keyFile, { kill }) {
  const child = spawn(restic, ["-r", repo, "--password-file", keyFile, "backup", "--stdin", "--stdin-filename", "partial"], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.write("half a dump");
  const locks = () => readdir(join(repo, "locks")).catch(() => []);
  for (let i = 0; i < 200 && !(await locks()).length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await locks()).length, 1, "restic took its lock");
  if (kill) {
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
  }
  return { child, locks };
}

test("set up once: a user limited to agouti_verify_* databases, its password root-only", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await setup();
  await assert.rejects(runVerify([], { p }), /Restore tests aren't set up yet/);
  const v = await setupVerifier({ host: "127.0.0.1", port: 3306 }, { p });
  assert.equal(v.user, "agouti_verify");
  assert.equal((await stat(v.credentials)).mode & 0o777, 0o600);
  assert.match(await readFile(v.credentials, "utf8"), /user="agouti_verify"\npassword="[\w-]{32}"\nhost="localhost"/);
  assert.deepEqual((await loadConfig(p)).verify.server, { host: "localhost", port: 3306 });
});

test("a restore test restores for real, checks, and cleans up", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await setup();
  await setupVerifier({ host: "127.0.0.1", port: 3306 }, { p });
  await backupApps([], { p });

  let r;
  const out = await captured(async () => (r = await runVerify([], { p })));
  assert.equal(r.ok, true, out);
  const [a] = r.apps;
  assert.equal(a.status, "verified");
  assert.deepEqual(a.database.tableRows, { users: 3, orders: 401 });
  assert.deepEqual(a.database.notLoaded, { triggers: 1, functions: 1 });
  assert.equal(a.files.total, 2);
  assert.equal(a.files.compared, 2, "unchanged live files are compared byte for byte");
  assert.match(out, /✓ Repository: no errors/);
  assert.match(out, /✓ database {2}2 tables · 404 rows · 1 view · 1 procedure restored/);
  assert.match(out, /1 trigger and 1 function checked in the dump only \(binary logging is on/);
  assert.match(out, /✓ files {5}2 of 2 files restored · 2 identical to the live copy/);
  assert.match(out, /✓ shop: backup verified/);

  assert.equal(existsSync(join(process.env.FAKE_MYSQL_DATA, throwawayName("shop"))), false, "throwaway database dropped");
  assert.equal(existsSync(join(p.dataDir, "verify-tmp", "shop")), false, "sampled files deleted");
  assert.equal((await loadState(p)).projects.shop.lastVerify.status, "verified");

  // Without binary logging, everything is loaded.
  process.env.FAKE_LOG_BIN = "0";
  try {
    await captured(async () => (r = await runVerify([], { p })));
  } finally {
    delete process.env.FAKE_LOG_BIN;
  }
  assert.deepEqual(r.apps[0].database.notLoaded, { triggers: 0, functions: 0 });
});

test("a backup that restores but looks wrong is flagged; a corrupted file fails", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir } = await setup();
  await setupVerifier({ host: "127.0.0.1", port: 3306 }, { p });
  await backupApps([], { p });
  await captured(() => runVerify([], { p }));

  // Someone deletes most orders; the nightly backup dutifully saves that.
  await writeFile(process.env.FAKE_DUMP, dumpWith(10));
  await backupApps([], { p });
  let r;
  const out = await captured(async () => (r = await runVerify([], { p })));
  assert.equal(r.ok, false);
  assert.equal(r.apps[0].status, "warning");
  assert.equal(r.apps[0].problems.length, 1);
  assert.match(r.apps[0].problems[0], /^orders: 401 rows in the last good test \(\d{4}-\d\d-\d\d\), 11 now\.$/);
  assert.match(out, /⚠ shop: the backup restores, but looks wrong:\n {4}orders: 401 rows in the last good test/);

  // #33: the same backup tested again still warns: it's compared with the last good test.
  await captured(async () => (r = await runVerify([], { p })));
  assert.equal(r.apps[0].status, "warning", "the warning doesn't go away by itself");
  assert.deepEqual(flaggedChanges(await loadState(p)).map((f) => f.app), ["shop"]);
  // Until someone accepts it: then that's the new normal.
  await acceptChange("shop", p);
  assert.equal((await loadState(p)).projects.shop.lastVerify.status, "verified");
  assert.deepEqual(flaggedChanges(await loadState(p)), []);
  await captured(async () => (r = await runVerify([], { p })));
  assert.equal(r.apps[0].status, "verified");

  // A live file that hasn't changed (same size and time) but whose backup differs: corruption.
  const file = join(dir, "storage/app/private/invoices/88.pdf");
  const { mtime } = await stat(file);
  await writeFile(file, Buffer.alloc(500, 1));
  await utimes(file, mtime, mtime);
  await captured(async () => (r = await runVerify([], { p })));
  assert.equal(r.apps[0].status, "failed");
  assert.match(r.apps[0].files.error, /88\.pdf: content differs from the live file, which hasn't changed/);
});

test("weekly: the scheduled run tests when due", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await setup();
  const config = await loadConfig(p);
  assert.equal(verifyDue(config, { projects: {} }), false, "not set up: never due");

  let out = await captured(() => scheduledBackup([], { p }));
  assert.doesNotMatch(out, /Testing shop/);

  await setupVerifier({ host: "127.0.0.1", port: 3306 }, { p });
  out = await captured(() => scheduledBackup([], { p }));
  assert.match(out, /Testing shop/, "never tested: due");
  out = await captured(() => scheduledBackup([], { p }));
  assert.doesNotMatch(out, /Testing shop/, "tested today: not due");

  const state = await loadState(p);
  const now = Date.parse(state.projects.shop.lastVerify.at);
  assert.equal(verifyDue(await loadConfig(p), state, now + 6 * 86400000), false);
  assert.equal(verifyDue(await loadConfig(p), state, now + 7 * 86400000), true);
});

test("agouti verify from the command line", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await setup();
  const env = { ...process.env, AGOUTI_CONFIG_DIR: p.configDir, AGOUTI_DATA_DIR: p.dataDir, NO_COLOR: "1" };
  const agouti = (...args) => spawnSync(process.execPath, [BIN, "verify", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  const notSetUp = agouti();
  assert.equal(notSetUp.status, 1);
  assert.match(notSetUp.stderr, /Restore tests aren't set up yet/);
  const setUp = agouti("--setup");
  assert.equal(setUp.status, 0, setUp.stderr);
  assert.match(setUp.stdout, /Restore tests are set up \(MySQL user agouti_verify\)/);
  await backupApps([], { p });
  const ok = agouti("shop");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /✓ shop: backup verified/);
});

test("an interrupted backup's lock doesn't block the restore test; a live one is reported, never verified", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, repo } = await setup();
  await setupVerifier({ host: "127.0.0.1", port: 3306 }, { p });
  await backupApps([], { p });

  const stale = await lockHolder(repo, p.recoveryKey, { kill: true });
  let r;
  let out = await captured(async () => (r = await runVerify([], { p })));
  assert.equal(r.ok, true, out);
  assert.match(out, /✓ Repository: no errors/);
  assert.deepEqual(await stale.locks(), [], "the stale lock was removed");

  const live = await lockHolder(repo, p.recoveryKey, { kill: false });
  try {
    out = await captured(async () => (r = await runVerify([], { p })));
  } finally {
    live.child.kill("SIGKILL");
  }
  assert.equal(r.ok, false);
  assert.equal(r.repository.locked, true);
  assert.match(out, /⚠ The repository check couldn't run: the storage is in use/);
  assert.doesNotMatch(out, /backup verified/, "a pass needs the repository check");
  assert.equal(r.apps[0].status, "warning");
  assert.equal((await loadState(p)).projects.shop.lastVerify.status, "warning", "the home screen shows ⚠, not ✓");
});

test("an interrupted backup's lock doesn't stop old restore points from being deleted", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, repo } = await setup();
  await backupApps([], { p });
  await new Promise((r) => setTimeout(r, 1100)); // point ids have one-second resolution
  await backupApps([], { p });
  await lockHolder(repo, p.recoveryKey, { kill: true });

  const config = await loadConfig(p);
  const kept = await applyRetention(config, { bin: restic, env: await resticEnv(config, p), policy: { daily: 1, weekly: 0, monthly: 0 } });
  assert.deepEqual(kept.apps.shop, { kept: 1, deleted: 1 });
  assert.equal(kept.pruned, true);
});

test("damaged backup data that a plain check misses is found: each test reads a different quarter of the data", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { root, p, repo } = await setup();
  await setupVerifier({ host: "127.0.0.1", port: 3306 }, { p });
  await backupApps([], { p });
  const env = await resticEnv(await loadConfig(p), p);
  const verify = async () => {
    let r;
    const out = await captured(async () => (r = await runVerify([], { p })));
    return { r, out };
  };

  // Healthy: tests read parts 1, 2, 3, 4, then start over.
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const { r, out } = await verify();
    assert.equal(r.ok, true, out);
    parts.push(r.repository.dataPart);
    if (i === 0) assert.match(out, /✓ Repository: no errors · read part 1 of 4 of the backup data \(all of it every 4 tests\)/);
  }
  assert.deepEqual(parts, [1, 2, 3, 4, 1]);

  // Data the app's restore point doesn't use (another backup in the same storage),
  // damaged in the middle of its data file, as in the rehearsal.
  const packs = async () => (await readdir(join(repo, "data"), { recursive: true })).filter((f) => /[0-9a-f]{64}$/.test(f));
  const before = new Set(await packs());
  const other = join(root, "other.bin");
  await writeFile(other, Buffer.from(Array.from({ length: 1 << 20 }, () => Math.floor(Math.random() * 256))));
  assert.equal(spawnSync(restic, ["backup", other], { env }).status, 0);
  const added = (await packs()).filter((f) => !before.has(f));
  const sizes = await Promise.all(added.map(async (f) => [(await stat(join(repo, "data", f))).size, f]));
  const dataPack = join(repo, "data", sizes.sort((a, b) => b[0] - a[0])[0][1]); // the 1 MB of file data, not the small tree pack
  await chmod(dataPack, 0o644);
  const fh = await open(dataPack, "r+");
  await fh.write(Buffer.alloc(64, 0xff), 0, 64, 500000);
  await fh.close();
  assert.equal(spawnSync(restic, ["check"], { env }).status, 0, "a plain check doesn't notice: that was #19");

  // Within four tests, the part holding it is read and the test fails.
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await verify());
  const caught = results.filter(({ r }) => !r.repository.ok);
  assert.equal(caught.length, 1, "exactly one part holds the damaged file");
  const [{ r, out }] = caught;
  assert.equal(r.ok, false);
  assert.equal(r.apps[0].status, "failed");
  assert.doesNotMatch(out, /backup verified/);
  assert.match(out, /✕ Repository: .*The storage may be damaged/);
  assert.deepEqual(results.map(({ r }) => r.repository.dataPart), [2, 3, 4, 1]);
});

test("a backup whose data shrank sharply is flagged, stays flagged, and holds retention until accepted", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await setup();
  await writeFile(process.env.FAKE_DUMP, dumpWith(300000)); // about 2 MB
  const [first] = await backupApps([], { p });
  assert.equal(first.shrunk, undefined);

  // 45 of 48 tables gone, as in the rehearsal: the dump falls to a few KB.
  await writeFile(process.env.FAKE_DUMP, dumpWith(10));
  let r;
  let out = await captured(async () => ([r] = await runBackup([], { p, live: false })));
  assert.equal(r.ok, true, "the backup itself worked");
  assert.match(r.shrunk, /The data shrank sharply: the database dump is [\d.]+ [KM]?B, down from 2.6 MB in the backup of \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.match(out, /⚠ shop: The data shrank sharply/);

  // Not just once: the next backup is compared with the last normal one, not with this.
  await new Promise((res) => setTimeout(res, 1100));
  await saveConfig({ ...(await loadConfig(p)), retention: { daily: 1, weekly: 0, monthly: 0 } }, p); // would delete 2 of 3
  out = await captured(() => scheduledBackup([], { p }));
  assert.match(out, /⚠ shop: The data shrank sharply/);
  assert.match(out, /Retention paused for shop/);
  const points = JSON.parse(spawnSync(restic, ["snapshots", "--json", "--tag", "part=database"], { env: await resticEnv(await loadConfig(p), p), encoding: "utf8" }).stdout);
  assert.equal(points.length, 3, "nothing deleted while flagged, though the policy keeps 1");
  const state = await loadState(p);
  assert.equal(state.projects.shop.shrunk.since, r.at, "flagged since the first small backup");
  assert.equal(state.projects.shop.baseline.point, first.point);

  await acceptChange("shop", p);
  await new Promise((res) => setTimeout(res, 1100));
  const [after] = await backupApps([], { p });
  assert.equal(after.shrunk, undefined, "accepted: the smaller data is the new normal");
  assert.deepEqual(flaggedChanges(await loadState(p)), []);
});

test("the home screen shows a flagged drop, and only a deliberate yes accepts it", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await setup();
  await recordBackup("shop", { ok: true, app: "shop", point: "20261107T104000Z", at: "2026-11-07T10:40:00.000Z", shrunk: "The data shrank sharply: the database dump is 2.7 MB, down from 37 MB." }, p);
  const accept = (opts) => {
    const choice = opts.choices.find((c) => c.value === "accept");
    assert.ok(choice, "offered while something is flagged");
    return "accept";
  };
  const ask = scripted([
    ["select", /What do you want to do/, accept],
    ["confirm", /removed from shop on purpose/, (o) => (assert.equal(o.default, false, "No is the safe default"), false)],
    ["select", /What do you want to do/, accept],
    ["confirm", /removed from shop on purpose/, true],
    ["select", /What do you want to do/, (opts) => (assert.equal(opts.choices.find((c) => c.value === "accept"), undefined, "gone once accepted"), "quit")],
  ]);
  const out = await captured(() => app({ ask, p }));
  assert.deepEqual(ask.remaining, []);
  assert.match(out, /⚠ shop: its backups shrank sharply \(since 2026-11-07 10:40 UTC\)\. Older restore points are kept until this is resolved\./);
  assert.match(out, /^ {2}shop +⚠ [^\n]*\(data shrank\)/m, "the status table doesn't show ✓ for it");
  assert.match(out, /The warning stays until the data is back or you accept it/);
  assert.match(out, /Accepted: shop's current data is the new normal/);
  assert.deepEqual(flaggedChanges(await loadState(p)), []);
});

test("upgrading: with no baseline yet in the state, a drop stays flagged on the next backups", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await setup();
  await writeFile(process.env.FAKE_DUMP, dumpWith(300000));
  const [good] = await backupApps([], { p });
  // State as an older version wrote it: no baseline.
  const file = join(p.dataDir, "state.json");
  const old = JSON.parse(await readFile(file, "utf8"));
  delete old.projects.shop.baseline;
  await writeFile(file, JSON.stringify(old));

  await writeFile(process.env.FAKE_DUMP, dumpWith(10));
  for (let i = 0; i < 2; i++) {
    await new Promise((res) => setTimeout(res, 1100));
    const [r] = await backupApps([], { p });
    assert.match(r.shrunk ?? "", /down from 2.6 MB/, `backup ${i + 1} after the drop is flagged`);
  }
  assert.equal((await loadState(p)).projects.shop.baseline.point, good.point);
});
