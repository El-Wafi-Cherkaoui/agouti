// Backups with real restic and a stand-in mysqldump (prints a fixed dump, or
// fails like a real one when FAIL_DUMP is set).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ago } from "../src/app.js";
import { backupApps, describeFailure, pointId } from "../src/backup.js";
import { saveConfig, saveRecoveryKey } from "../src/config.js";
import { routinesVisible } from "../src/mysql.js";
import { paths } from "../src/paths.js";
import { ensureRestic, run } from "../src/restic.js";
import { acquireLock, loadState } from "../src/state.js";
import { laravelFixture } from "./helpers.js";

const CACHE = fileURLToPath(new URL("./.cache", import.meta.url));
const DUMP = "-- fake dump\nCREATE TABLE `users` (id int);\nINSERT INTO `users` VALUES (1);\n";
let restic;

before(async () => {
  try {
    restic = await ensureRestic({ p: paths({ AGOUTI_DATA_DIR: CACHE }) });
    process.env.AGOUTI_RESTIC = restic;
  } catch (err) {
    console.warn(`skipping backup tests: ${err.message}`);
  }
  const dir = await mkdtemp(join(tmpdir(), "agouti-fakedump-"));
  const fake = join(dir, "mysqldump");
  await writeFile(
    fake,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "mysqldump  Ver 8.4.11 for Linux"; exit 0; fi
if [ -n "$FAIL_DUMP" ]; then echo "mysqldump: Got error: 1045: Access denied for user 'shop'@'localhost' (using password: YES) when trying to connect" >&2; exit 2; fi
printf '%s' '${DUMP}'
`,
  );
  await chmod(fake, 0o755);
  process.env.AGOUTI_MYSQLDUMP = fake;
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agouti-backup-"));
  const p = paths({ AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") });
  const repo = join(root, "repo");
  await saveRecoveryKey("agouti-rk-TEST", p);
  execFileSync(restic, ["init", "-r", repo, "--password-file", p.recoveryKey], { stdio: "ignore" });
  const dir = await laravelFixture();
  const project = {
    path: dir,
    framework: "laravel",
    database: { engine: "mysql", name: "shop_prod", host: "127.0.0.1", port: 3306, user: "shop", credentials: join(root, "shop.cnf"), source: "manual" },
    files: ["storage/app/public", "storage/app/private"],
  };
  await saveConfig({ repository: repo, projects: { shop: project } }, p);
  const restic_ = (...args) => run(restic, ["-r", repo, "--password-file", p.recoveryKey, ...args]);
  return { p, dir, repo, restic: restic_ };
}

test("a backup makes one restore point: database + files snapshots with the same point tag", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, restic: r } = await setup();
  const events = [];
  const [result] = await backupApps([], { p, onEvent: (e) => events.push(e.type) });

  assert.equal(result.ok, true);
  assert.equal(result.database.bytes, Buffer.byteLength(DUMP));
  assert.equal(result.files.files, 2);
  assert.deepEqual(
    events.filter((e) => e !== "progress"),
    ["app-start", "part-start", "part-done", "part-start", "part-done", "app-done"],
  );

  const snaps = JSON.parse((await r("snapshots", "--json", "--tag", `point=${result.point}`)).stdout);
  assert.deepEqual(snaps.map((s) => s.tags.find((x) => x.startsWith("part="))).sort(), ["part=app", "part=database", "part=files"]);
  for (const s of snaps) assert.ok(s.tags.includes("app=shop") && s.tags.includes("agouti"));

  // What a new server needs to find and restore the app, without any credentials.
  const described = snaps.find((s) => s.tags.includes("part=app"));
  const app = JSON.parse((await r("dump", described.id, "/agouti-app.json")).stdout);
  assert.equal(app.app, "shop");
  assert.equal(app.database.name, "shop_prod");
  assert.deepEqual(app.files, ["storage/app/public", "storage/app/private"]);
  assert.doesNotMatch(JSON.stringify(app), /credentials|password|\.cnf/);

  // The dump is stored as-is and can be read back.
  assert.equal((await r("dump", result.database.snapshot, "/shop_prod.sql")).stdout, DUMP);

  const state = await loadState(p);
  assert.equal(state.projects.shop.lastBackup.point, result.point);
  assert.equal(state.projects.shop.lastSuccess.point, result.point);
});

test("a failing dump saves no database snapshot, still saves files, and explains", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, restic: r } = await setup();
  const [good] = await backupApps([], { p });

  process.env.FAIL_DUMP = "1";
  let bad;
  try {
    [bad] = await backupApps(["shop"], { p });
  } finally {
    delete process.env.FAIL_DUMP;
  }
  assert.equal(bad.ok, false);
  assert.match(bad.database.error, /^Got error: 1045: Access denied/);
  assert.match(bad.database.hint, /password of shop changed/);
  assert.equal(bad.files.ok, true);

  const snaps = JSON.parse((await r("snapshots", "--json", "--tag", `point=${bad.point}`)).stdout);
  assert.deepEqual(
    snaps.map((s) => s.tags.find((x) => x.startsWith("part="))),
    ["part=files", "part=app"],
    "no partial dump may be stored",
  );

  const state = (await loadState(p)).projects.shop;
  assert.equal(state.lastBackup.ok, false);
  assert.equal(state.lastSuccess.point, good.point, "the last good backup is remembered");
});

test("a missing upload folder fails the files part loudly", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, dir } = await setup();
  await rm(join(dir, "storage/app/private"), { recursive: true });
  const [result] = await backupApps([], { p });
  assert.equal(result.database.ok, true);
  assert.equal(result.files.ok, false);
  assert.match(result.files.error, /Folder missing: .*storage\/app\/private/);
});

test("only one backup runs at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "agouti-lock-"));
  const p = paths({ AGOUTI_CONFIG_DIR: root, AGOUTI_DATA_DIR: join(root, "var") });
  const release = await acquireLock(p);
  // Pretend another live process holds it: our parent process.
  await writeFile(join(p.dataDir, "backup.lock"), String(process.ppid));
  await assert.rejects(acquireLock(p), /Another backup is already running/);
  // A lock left by a dead process is taken over.
  await writeFile(join(p.dataDir, "backup.lock"), "999999");
  const again = await acquireLock(p);
  await again();
  await release();
});

test("restic failure messages are reduced to the useful line", () => {
  const r = {
    code: 1,
    messages: [],
    stderr: [
      "subprocess mysqldump: mysqldump: shop has insufficient privileges to SHOW CREATE PROCEDURE `p1`!",
      '{"message_type":"exit_error","code":1,"message":"Fatal: unable to save snapshot"}',
    ].join("\n"),
  };
  assert.equal(describeFailure(r, "mysqldump"), "shop has insufficient privileges to SHOW CREATE PROCEDURE `p1`!");
  assert.equal(describeFailure({ ...r, stderr: r.stderr.split("\n")[1] }, "mysqldump"), "unable to save snapshot");
});

test("grants: can this user see stored procedures?", () => {
  const t = (...g) => routinesVisible(g, "shop_prod");
  assert.equal(t("GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON `shop_prod`.* TO `b`@`%`"), false);
  assert.equal(t("GRANT SHOW_ROUTINE ON *.* TO `b`@`%`"), true);
  assert.equal(t("GRANT ALL PRIVILEGES ON `shop\\\\_prod`.* TO `shop`@`%`"), true); // as printed by mysql --batch
  assert.equal(t("GRANT ALL PRIVILEGES ON `shop%`.* TO `shop`@`%`"), true);
  assert.equal(t("GRANT ALL PRIVILEGES ON `other`.* TO `shop`@`%`"), false);
  assert.equal(t("GRANT SELECT ON `mysql`.`proc` TO `x`@`%`"), true);
});

test("restore point ids and relative times", () => {
  assert.equal(pointId(new Date("2026-11-03T14:20:05.123Z")), "20261103T142005Z");
  const now = Date.parse("2026-11-03T12:00:00Z");
  assert.equal(ago("2026-11-03T11:59:30Z", now), "just now");
  assert.equal(ago("2026-11-03T11:15:00Z", now), "45min ago");
  assert.equal(ago("2026-11-03T06:00:00Z", now), "6h ago");
  assert.equal(ago("2026-11-02T10:00:00Z", now), "yesterday");
  assert.equal(ago("2026-10-30T12:00:00Z", now), "4 days ago");
});
