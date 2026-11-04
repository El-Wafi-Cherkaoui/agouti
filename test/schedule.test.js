// Automatic backups: retention, the systemd timer (with a stand-in systemctl), and
// a full scheduled run with real restic and a local server playing healthchecks.io.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, loadCredentials, saveConfig, saveCredentials, saveRecoveryKey } from "../src/config.js";
import { scheduledBackup } from "../src/flows/backup.js";
import { maskUrl, scheduleFlow } from "../src/flows/schedule.js";
import { loadHealthcheck, saveHealthcheck, validateHealthcheckUrl } from "../src/healthcheck.js";
import { paths } from "../src/paths.js";
import { pointsToKeep, weekKey } from "../src/retention.js";
import { ensureRestic, resticEnv, run } from "../src/restic.js";
import { installSchedule, parseTime, removeSchedule, scheduleStatus, splitExec, unitFiles } from "../src/schedule.js";
import { captured, laravelFixture, scripted } from "./helpers.js";

const CACHE = fileURLToPath(new URL("./.cache", import.meta.url));
let restic;

before(async () => {
  try {
    restic = await ensureRestic({ p: paths({ AGOUTI_DATA_DIR: CACHE }) });
    process.env.AGOUTI_RESTIC = restic;
  } catch (err) {
    console.warn(`skipping restic tests: ${err.message}`);
  }
  const dir = await mkdtemp(join(tmpdir(), "agouti-fakedump-"));
  const fake = join(dir, "mysqldump");
  await writeFile(
    fake,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "mysqldump  Ver 8.4.11 for Linux"; exit 0; fi
if [ -n "$FAIL_DUMP" ]; then echo "mysqldump: Got error: 1045: Access denied for user 'shop'@'localhost'" >&2; exit 2; fi
echo "-- dump $(date +%s%N)"
`,
  );
  await chmod(fake, 0o755);
  process.env.AGOUTI_MYSQLDUMP = fake;
});

const pt = (id, iso, complete = true) => ({ id, at: new Date(iso), complete });

test("retention keeps the newest point of each day, week and month", () => {
  const points = [
    pt("a", "2026-11-03T03:00Z"),
    pt("b", "2026-11-02T15:00Z"), // manual, before a deploy
    pt("c", "2026-11-02T03:00Z"),
    pt("d", "2026-11-01T03:00Z"),
    pt("e", "2026-10-25T03:00Z"),
    pt("f", "2026-10-01T03:00Z"),
    pt("g", "2026-09-30T03:00Z"),
  ];
  assert.deepEqual([...pointsToKeep(points, { daily: 2, weekly: 0, monthly: 0 })].sort(), ["a", "b"]);
  // Weeks: a (W45), d (W44: Sunday Nov 1), e (W43).
  assert.deepEqual([...pointsToKeep(points, { daily: 0, weekly: 3, monthly: 0 })].sort(), ["a", "d", "e"]);
  assert.deepEqual([...pointsToKeep(points, { daily: 0, weekly: 0, monthly: 3 })].sort(), ["a", "e", "g"]);
  assert.deepEqual([...pointsToKeep(points, { daily: 7, weekly: 4, monthly: 12 })].sort(), ["a", "b", "d", "e", "f", "g"]);
  assert.deepEqual(pointsToKeep([], { daily: 7 }).size, 0);
});

test("retention: incomplete points never displace complete ones", () => {
  const points = [
    pt("new-broken", "2026-11-03T03:00Z", false), // newest: kept, its files may be the latest copy
    pt("good", "2026-11-02T03:00Z"),
    pt("old-broken", "2026-11-01T03:00Z", false),
    pt("older", "2026-10-31T03:00Z"),
  ];
  assert.deepEqual([...pointsToKeep(points, { daily: 1, weekly: 0, monthly: 0 })].sort(), ["good", "new-broken"]);
  assert.deepEqual([...pointsToKeep(points, { daily: 2, weekly: 0, monthly: 0 })].sort(), ["good", "new-broken", "older"]);
});

test("ISO weeks across a year boundary", () => {
  assert.equal(weekKey(new Date("2026-12-31T12:00Z")), "2026-W53");
  assert.equal(weekKey(new Date("2027-01-03T12:00Z")), "2026-W53"); // Sunday
  assert.equal(weekKey(new Date("2027-01-04T12:00Z")), "2027-W1");
  assert.equal(weekKey(new Date("2024-12-30T12:00Z")), "2025-W1");
});

test("times, unit files and the healthcheck URL", () => {
  assert.equal(parseTime("3:05"), "03:05");
  assert.equal(parseTime(" 23:59 "), "23:59");
  for (const bad of ["24:00", "3", "03:60", "3pm", ""]) assert.throws(() => parseTime(bad), /Not a time/);

  const { service, timer } = unitFiles("03:00", { command: ["/home/me/.nvm/versions/node/v22/bin/node", "/opt/agouti dir/bin/agouti.js"], env: {} });
  assert.match(timer, /^OnCalendar=\*-\*-\* 03:00:00$/m);
  assert.match(timer, /^Persistent=true$/m);
  const exec = service.match(/^ExecStart=(.*)$/m)[1];
  assert.deepEqual(splitExec(exec), ["/home/me/.nvm/versions/node/v22/bin/node", "/opt/agouti dir/bin/agouti.js", "backup", "--scheduled"]);
  assert.doesNotMatch(service, /AGOUTI_CONFIG_DIR/);
  assert.match(unitFiles("03:00", { command: ["/n", "/a"], env: { AGOUTI_CONFIG_DIR: "/x y" } }).service, /^Environment="AGOUTI_CONFIG_DIR=\/x y"$/m);

  assert.equal(validateHealthcheckUrl(" https://hc-ping.com/abc/ "), "https://hc-ping.com/abc");
  assert.throws(() => validateHealthcheckUrl("hc-ping.com/abc"), /Not a URL/);
  assert.throws(() => validateHealthcheckUrl("ftp://x/y"), /https/);
  assert.equal(maskUrl("https://hc-ping.com/1f2e3d4c-aaaa-bbbb"), "hc-ping.com/1f2e3d…");
});

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "agouti-schedule-"));
  const env = { AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") };
  const p = paths(env);
  const repo = join(root, "repo");
  await saveRecoveryKey("agouti-rk-TEST", p);
  if (restic) execFileSync(restic, ["init", "-r", repo, "--password-file", p.recoveryKey], { stdio: "ignore" });
  const dir = await laravelFixture();
  const project = {
    path: dir,
    framework: "laravel",
    database: { engine: "mysql", name: "shop_prod", host: "127.0.0.1", port: 3306, user: "shop", credentials: join(root, "shop.cnf") },
    files: ["storage/app/public"],
  };
  await saveConfig({ repository: repo, projects: { shop: project } }, p);
  return { root, p, env, repo, dir };
}

// A stand-in systemctl that logs its arguments.
async function fakeSystemctl(root) {
  const log = join(root, "systemctl.log");
  const bin = join(root, "systemctl");
  await writeFile(
    bin,
    `#!/bin/sh
echo "$@" >> ${log}
if [ "$1" = "show" ]; then printf 'ActiveState=active\\nNextElapseUSecRealtime=Wed 2026-11-04 03:00:00 UTC\\n'; fi
`,
  );
  await chmod(bin, 0o755);
  return { log, env: { AGOUTI_SYSTEMD_DIR: root, AGOUTI_SYSTEMCTL: bin } };
}

test("installing, checking and removing the timer", async () => {
  const { root, p, env: dirs } = await sandbox();
  const fake = await fakeSystemctl(root);
  const log = fake.log;
  const env = { ...process.env, ...dirs, ...fake.env };

  const config = await loadConfig(p);
  const status = await installSchedule(config, "3:00", { p, env });
  assert.deepEqual(status, { enabled: true, time: "03:00", nextRun: "Wed 2026-11-04 03:00:00 UTC" });
  assert.equal((await loadConfig(p)).schedule, "daily 03:00");
  assert.match(await readFile(join(root, "agouti-backup.service"), "utf8"), /backup --scheduled/);
  assert.match(await readFile(log, "utf8"), /daemon-reload\nenable --now agouti-backup.timer\nrestart agouti-backup.timer/);

  // A timer pointing at a Node that's gone is reported, not silently trusted.
  const svc = join(root, "agouti-backup.service");
  await writeFile(svc, (await readFile(svc, "utf8")).replace(/^ExecStart=\S+/m, "ExecStart=/gone/node"));
  assert.match((await scheduleStatus(config, { env })).problem, /\/gone\/node no longer exists/);

  await removeSchedule(config, { p, env });
  assert.equal((await loadConfig(p)).schedule, undefined);
  assert.match(await readFile(log, "utf8"), /disable --now agouti-backup.timer\ndaemon-reload\n$/);
  assert.deepEqual(await scheduleStatus(await loadConfig(p), { env }), { enabled: false });
});

// A local stand-in for healthchecks.io that records every ping.
async function healthcheckServer() {
  const pings = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      pings.push({ path: req.url, body });
      res.end("OK");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/ping/abc`, pings, close: () => server.close() };
}

test("a scheduled run backs up, deletes old points and pings the healthcheck", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await sandbox();
  const hc = await healthcheckServer();
  t.after(hc.close);
  await saveHealthcheck(hc.url, p);
  const config = await loadConfig(p);
  config.retention = { daily: 1, weekly: 0, monthly: 0 };
  await saveConfig(config, p);

  // The URL is Agouti's: restic never sees it.
  assert.equal((await resticEnv(config, p)).AGOUTI_HEALTHCHECK_URL, undefined);
  assert.equal((await loadCredentials(p)).AGOUTI_HEALTHCHECK_URL, hc.url);

  assert.equal(await captured(() => scheduledBackup([], { p })).then(() => true), true);
  await new Promise((r) => setTimeout(r, 1100)); // a new point id needs a new second
  let ok;
  const out = await captured(async () => (ok = await scheduledBackup([], { p })));
  assert.equal(ok, true);
  assert.match(out, /Retention \(1 daily, 0 weekly, 0 monthly\): deleted 1 old restore point/);

  const env = await resticEnv(config, p);
  const snaps = JSON.parse((await run(restic, ["snapshots", "--json"], { env })).stdout);
  assert.equal(snaps.length, 3, "one point left: its database, files and app description snapshots");
  assert.equal(new Set(snaps.map((s) => s.tags.find((x) => x.startsWith("point=")))).size, 1);

  assert.deepEqual(
    hc.pings.map((x) => x.path),
    ["/ping/abc/start", "/ping/abc", "/ping/abc/start", "/ping/abc"],
  );
  assert.match(hc.pings[3].body, /shop: ok\nRetention/);

  // A failing dump: the healthcheck hears "fail", with the reason.
  process.env.FAIL_DUMP = "1";
  try {
    await captured(async () => (ok = await scheduledBackup([], { p })));
  } finally {
    delete process.env.FAIL_DUMP;
  }
  assert.equal(ok, false);
  assert.equal(hc.pings.at(-1).path, "/ping/abc/fail");
  assert.match(hc.pings.at(-1).body, /shop: FAILED database: Got error: 1045: Access denied/);

  // Removing the healthcheck keeps the other credentials.
  await saveHealthcheck(null, p);
  assert.equal(await loadHealthcheck(p), null);
});

test("a scheduled run that can't even start still reports failure to the healthcheck", async (t) => {
  const { p } = await sandbox();
  const hc = await healthcheckServer();
  t.after(hc.close);
  await saveHealthcheck(hc.url, p);
  await saveConfig({ ...(await loadConfig(p)), projects: {} }, p);
  await assert.rejects(
    captured(() => scheduledBackup([], { p })),
    /no apps to back up/,
  );
  assert.deepEqual(
    hc.pings.map((x) => x.path),
    ["/ping/abc/start", "/ping/abc/fail"],
  );
  assert.match(hc.pings[1].body, /FAILED: There are no apps/);
});

test("interactive: turn on with a healthcheck, then turn off", async (t) => {
  const { root, p } = await sandbox();
  const fake = await fakeSystemctl(root);
  Object.assign(process.env, fake.env);
  t.after(() => Object.keys(fake.env).forEach((k) => delete process.env[k]));
  const hc = await healthcheckServer();
  t.after(hc.close);

  const ask = scripted([
    ["input", /Back up every day at/, "4:30"],
    ["select", /Set up a healthcheck/, "yes"],
    ["input", /Ping URL/, hc.url],
    ["confirm", /Also get a message/, false],
    ["confirm", /Set up weekly restore tests/, false],
  ]);
  const out = await captured(() => scheduleFlow(ask, { p }));
  assert.equal(ask.remaining.length, 0);
  assert.match(out, /keeps the last 7 days,\s+4 weeks and 12 months/);
  assert.match(out, /Test ping sent/);
  assert.match(out, /No restore tests: you won't know if backups can't be restored/);
  assert.match(out, /Daily backups at 04:30/);
  assert.match(out, /Healthcheck: 127\.0\.0\.1:\d+\/ping\/abc\. You.ll be alerted/);
  assert.equal(await loadHealthcheck(p), hc.url);
  assert.deepEqual((await loadConfig(p)).retention, { daily: 7, weekly: 4, monthly: 12 }, "written so it can be edited");

  const off = scripted([
    ["select", /What do you want to change/, (o) => (assert.ok(o.choices.some((c) => c.value === "no-healthcheck")), "off")],
    ["confirm", /Turn off automatic backups/, true],
  ]);
  assert.match(await captured(() => scheduleFlow(off, { p })), /Automatic backups are off/);
  assert.equal((await loadConfig(p)).schedule, undefined);
});

test("append-only storage: the nightly run re-checks it, and pauses retention on R2", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await sandbox();
  const hc = await healthcheckServer();
  t.after(hc.close);
  await saveHealthcheck(hc.url, p);
  // Recorded as protected, but this (local) storage can't refuse deletes: as if the
  // lock rules had been removed since.
  const config = await loadConfig(p);
  config.protection = { kind: "r2", checkedAt: new Date().toISOString() };
  await saveConfig(config, p);

  let ok;
  const out = await captured(async () => (ok = await scheduledBackup([], { p })));
  assert.equal(ok, false);
  assert.match(out, /✕ Append-only storage is no longer in place: storage SFTP and local folders can't be made append-only/);
  assert.match(out, /Retention paused: the storage is append-only/);
  assert.equal(hc.pings.at(-1).path, "/ping/abc/fail");
  assert.match(hc.pings.at(-1).body, /Append-only storage FAILED/);
});

test("alerts: a message saying what failed and what to do, then one when it works again", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p } = await sandbox();
  const hook = await healthcheckServer(); // records POSTs: a stand-in webhook
  t.after(hook.close);
  // Written directly: saveAlert only accepts https URLs.
  await saveCredentials({ ...(await loadCredentials(p)), AGOUTI_ALERT_WEBHOOK: hook.url.replace("/ping/abc", "/hook") }, p);
  const sent = () => hook.pings.map((x) => JSON.parse(x.body));

  process.env.FAIL_DUMP = "1";
  try {
    await captured(() => scheduledBackup([], { p }));
  } finally {
    delete process.env.FAIL_DUMP;
  }
  let [failure] = sent();
  assert.equal(failure.event, "failure");
  assert.match(failure.title, /^✕ Agouti on .+: a problem with tonight's backup$/);
  assert.deepEqual(failure.lines, [
    "shop: the database wasn't backed up: Got error: 1045: Access denied for user 'shop'@'localhost'",
    `  Has the password of shop changed? Credentials are in ${join(p.configDir, "..", "shop.cnf")}.`,
    "  Details: journalctl -u agouti-backup",
  ]);

  await captured(() => scheduledBackup([], { p }));
  assert.equal(sent()[1].event, "recovered");
  assert.match(sent()[1].title, /backups are working again/);

  await captured(() => scheduledBackup([], { p }));
  assert.equal(sent().length, 2, "all good, and was good: no message");
});

test("a file that can't be read reaches the alerts, though the rest is saved", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  if (process.getuid?.() === 0) return t.skip("root can read everything");
  const { p, dir } = await sandbox();
  const hook = await healthcheckServer();
  t.after(hook.close);
  await saveCredentials({ ...(await loadCredentials(p)), AGOUTI_ALERT_WEBHOOK: hook.url.replace("/ping/abc", "/hook") }, p);
  const locked = join(dir, "storage/app/public/locked.pdf");
  await writeFile(locked, "secret");
  await chmod(locked, 0o000);

  let ok;
  await captured(async () => (ok = await scheduledBackup([], { p })));
  assert.equal(ok, false);
  const [message] = hook.pings.map((x) => JSON.parse(x.body));
  assert.equal(message.event, "failure");
  assert.ok(message.lines[0].startsWith("shop: 1 file couldn't be read and is missing from this backup: "), message.lines[0]);
  assert.ok(message.lines[0].includes("locked.pdf"));
  assert.match(message.lines[1], /The rest was backed up/);

  await chmod(locked, 0o644);
  await captured(async () => (ok = await scheduledBackup([], { p })));
  assert.equal(ok, true);
  assert.equal(JSON.parse(hook.pings[1].body).event, "recovered");
});
