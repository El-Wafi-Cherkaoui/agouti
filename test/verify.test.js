// Restore tests: real restic, and the stand-in MySQL from helpers.js, which (like
// MySQL with binary logging on) refuses triggers, functions and other users'
// DEFINERs to the restricted agouti_verify user.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { backupApps } from "../src/backup.js";
import { loadConfig, saveConfig, saveRecoveryKey } from "../src/config.js";
import { dumpFilter } from "../src/dump.js";
import { scheduledBackup } from "../src/flows/backup.js";
import { runVerify } from "../src/flows/verify.js";
import { paths } from "../src/paths.js";
import { ensureRestic } from "../src/restic.js";
import { loadState } from "../src/state.js";
import { sameServer, setupVerifier, throwawayName, verifyDue } from "../src/verify.js";
import { captured, installFakeMysql, laravelFixture } from "./helpers.js";

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
  return { root, p, dir };
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
  assert.deepEqual(r.apps[0].problems, ["orders: 401 rows in the last test, 11 now."]);
  assert.match(out, /⚠ shop: the backup restores, but looks wrong:\n {4}orders: 401 rows in the last test, 11 now\./);

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
