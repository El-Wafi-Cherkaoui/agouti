// Automatic backups with a systemd timer: agouti-backup.timer starts
// agouti-backup.service every day, which runs `agouti backup --scheduled`.
//
// The service calls node and agouti by absolute path, so it works whatever root's
// PATH is (nvm, a custom Node install...). If that Node is later removed, the
// timer breaks: scheduleStatus() notices, and the healthcheck alerts.
import { existsSync, realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveConfig, writeAtomic } from "./config.js";
import { paths } from "./paths.js";
import { run } from "./restic.js";
import { isWindows, windowsPowershellEnv } from "./platform.js";
import { UserError } from "./ui.js";

export const TIMER = "agouti-backup.timer";
export const SERVICE = "agouti-backup.service";
// Windows: a Task Scheduler task instead of a systemd timer.
export const TASK = "Agouti backup";

const unitDir = (env = process.env) => env.AGOUTI_SYSTEMD_DIR || "/etc/systemd/system";
const systemctlBin = (env = process.env) => env.AGOUTI_SYSTEMCTL || "systemctl";

// "3:00" -> "03:00". Throws on anything else.
export function parseTime(text) {
  const m = String(text ?? "")
    .trim()
    .match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new UserError(`Not a time: ${text}`, "Use 24-hour HH:MM, e.g. 03:00.");
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

// config.schedule is "daily HH:MM" (or absent).
export function scheduledTime(config) {
  const m = String(config?.schedule ?? "").match(/^daily (\d\d:\d\d)$/);
  return m ? m[1] : null;
}

export function serverTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "server time";
}

// The command the service runs: this very Node and this very agouti.
export function agoutiCommand() {
  const script = realpathSync(fileURLToPath(new URL("../bin/agouti.js", import.meta.url)));
  return [process.execPath, script];
}

export function unitFiles(time, { command = agoutiCommand(), env = process.env } = {}) {
  const quote = (a) => (/[\s"'\\$%;]/.test(a) ? `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"` : a);
  // Tests (and unusual setups) point Agouti at other directories: the timer must use the same ones.
  const extra = ["AGOUTI_CONFIG_DIR", "AGOUTI_DATA_DIR", "AGOUTI_RESTIC", "AGOUTI_MYSQLDUMP"]
    .filter((k) => env[k])
    .map((k) => `Environment=${quote(`${k}=${env[k]}`)}\n`)
    .join("");
  const service = `# Written by Agouti (\`agouti schedule\`). Changes are overwritten.
[Unit]
Description=Agouti: back up apps (database + files)
Wants=network-online.target
# A backup missed while the server was off runs at boot: not before the database is up.
After=network-online.target mysql.service mariadb.service mysqld.service

[Service]
Type=oneshot
ExecStart=${[...command, "backup", "--scheduled"].map(quote).join(" ")}
Environment=NO_COLOR=1
${extra}# Be gentle with the apps still serving traffic.
Nice=10
IOSchedulingClass=idle
`;
  const timer = `# Written by Agouti (\`agouti schedule\`). Changes are overwritten.
[Unit]
Description=Agouti: daily backup at ${time}

[Timer]
OnCalendar=*-*-* ${time}:00
# If the server was off at that time, run as soon as it's back.
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

function requireSystemd(env = process.env) {
  if (env.AGOUTI_SYSTEMD_DIR) return;
  if (!existsSync("/run/systemd/system")) {
    const [node, script] = agoutiCommand();
    throw new UserError(
      "systemd isn't running on this server, so Agouti can't install its timer.",
      `Use cron instead. Put this line in /etc/cron.d/agouti:\n  0 3 * * * root ${node} ${script} backup --scheduled`,
    );
  }
}

async function systemctl(args, env = process.env) {
  let r;
  try {
    r = await run(systemctlBin(env), args, { env });
  } catch (err) {
    throw new UserError(`Couldn't run systemctl: ${err.message}`);
  }
  if (r.code !== 0) throw new UserError(`systemctl ${args.join(" ")} failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  return r.stdout.trim();
}

// Installs (or updates) the timer and records the time in the config.
export async function installSchedule(config, time, { p = paths(), env = process.env } = {}) {
  time = parseTime(time);
  if (isWindows()) {
    await installTask(time, { p, env });
    config.schedule = `daily ${time}`;
    await saveConfig(config, p);
    return scheduleStatus(config, { env });
  }
  requireSystemd(env);
  const { service, timer } = unitFiles(time, { env });
  await writeAtomic(join(unitDir(env), SERVICE), service, 0o644);
  await writeAtomic(join(unitDir(env), TIMER), timer, 0o644);
  await systemctl(["daemon-reload"], env);
  await systemctl(["enable", "--now", TIMER], env);
  // restart: a changed time takes effect now, not after the next run.
  await systemctl(["restart", TIMER], env);
  config.schedule = `daily ${time}`;
  await saveConfig(config, p);
  return scheduleStatus(config, { env });
}

export async function removeSchedule(config, { p = paths(), env = process.env } = {}) {
  if (isWindows()) {
    if ((await schtasks(["/Query", "/TN", TASK], env, { check: false })).code === 0) await schtasks(["/Delete", "/TN", TASK, "/F"], env);
    delete config.schedule;
    await saveConfig(config, p);
    return;
  }
  const dir = unitDir(env);
  const installed = existsSync(join(dir, TIMER));
  if (installed) {
    requireSystemd(env);
    await systemctl(["disable", "--now", TIMER], env);
  }
  await rm(join(dir, TIMER), { force: true });
  await rm(join(dir, SERVICE), { force: true });
  if (installed) await systemctl(["daemon-reload"], env);
  delete config.schedule;
  await saveConfig(config, p);
}

// { enabled, time, problem?, nextRun? }. problem explains why a configured
// schedule won't actually run.
export async function scheduleStatus(config, { env = process.env } = {}) {
  const time = scheduledTime(config);
  if (!time) return { enabled: false };
  const status = { enabled: true, time };
  if (isWindows()) return { ...status, ...(await taskStatus(env)) };
  let service;
  try {
    service = await readFile(join(unitDir(env), SERVICE), "utf8");
    await readFile(join(unitDir(env), TIMER), "utf8");
  } catch {
    return { ...status, problem: "The timer isn't installed on this server." };
  }
  const [node, script] = splitExec(service.match(/^ExecStart=(.*)$/m)?.[1] ?? "");
  for (const f of [node, script]) {
    if (f && !existsSync(f)) return { ...status, problem: `${f} no longer exists (Node or Agouti was moved or removed).` };
  }
  try {
    const out = await systemctl(["show", TIMER, "--property=ActiveState,NextElapseUSecRealtime"], env);
    const props = Object.fromEntries(out.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    if (props.ActiveState && props.ActiveState !== "active") return { ...status, problem: `The timer is ${props.ActiveState}.` };
    if (props.NextElapseUSecRealtime) status.nextRun = props.NextElapseUSecRealtime;
  } catch (err) {
    return { ...status, problem: err.message };
  }
  return status;
}

// Splits an ExecStart= line as written by unitFiles() (plain words, or "quoted").
export function splitExec(line) {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%") : m[2]));
}

// --- Windows: Task Scheduler ---------------------------------------------------
// The task runs as SYSTEM (no password to store, survives logoff), daily at the
// time, and late if the server was off then (StartWhenAvailable, like systemd's
// Persistent=true). Written as XML: schtasks' own options can't set that.

const schtasksBin = (env = process.env) => env.AGOUTI_SCHTASKS || "schtasks";

async function schtasks(args, env = process.env, { check = true } = {}) {
  let r;
  try {
    r = await run(schtasksBin(env), args, { env });
  } catch (err) {
    throw new UserError(`Couldn't run schtasks: ${err.message}`);
  }
  if (check && r.code !== 0) throw new UserError(`schtasks ${args[0]} failed: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
  return r;
}

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Windows command-line quoting (CommandLineToArgvW rules), for the task's arguments.
export const winArg = (a) => (/^[^\s"]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`);

// Task Scheduler keeps no output, so cmd writes the run's output to this file.
export const taskLog = (p = paths()) => join(p.dataDir, "last-backup.log");

export function taskXml(time, { command = agoutiCommand(), env = process.env, today = new Date(), log = taskLog() } = {}) {
  // Tests (and unusual setups) point Agouti at other directories: the task must use
  // the same ones. A task can't set environment variables, so cmd sets them.
  const extra = ["AGOUTI_CONFIG_DIR", "AGOUTI_DATA_DIR", "AGOUTI_RESTIC", "AGOUTI_MYSQLDUMP"].filter((k) => env[k]);
  const run = [...command, "backup", "--scheduled"].map(winArg).join(" ");
  const exec = {
    command: env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
    args: `/d /s /c "${extra.map((k) => `set "${k}=${env[k]}" && `).join("")}${run} > ${winArg(log)} 2>&1"`,
  };
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Agouti: back up apps (database + files). Written by Agouti (agouti schedule); changes are overwritten.</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${day}T${time}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT12H</ExecutionTimeLimit>
    <!-- Below normal: be gentle with the apps still serving traffic. -->
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(exec.command)}</Command>
      <Arguments>${xmlEscape(exec.args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

async function installTask(time, { p, env }) {
  const file = join(p.dataDir, `schedule-${process.pid}.xml`);
  // schtasks reads the file as UTF-16 (what the declaration says), with its BOM.
  await writeAtomic(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(time, { env, log: taskLog(p) }), "utf16le")]), 0o600);
  try {
    await schtasks(["/Create", "/TN", TASK, "/XML", file, "/F"], env);
  } finally {
    await rm(file, { force: true });
  }
}

// What the task really runs and when, read back from Task Scheduler (PowerShell's
// ScheduledTasks module: its output doesn't depend on the Windows language).
async function taskStatus(env) {
  const script = `$ErrorActionPreference='Stop'; $t = Get-ScheduledTask -TaskName '${TASK}'; $i = $t | Get-ScheduledTaskInfo; ` +
    `[pscustomobject]@{ state = "$($t.State)"; exe = $t.Actions[0].Execute; args = $t.Actions[0].Arguments; ` +
    `next = $(if ($i.NextRunTime) { $i.NextRunTime.ToString('yyyy-MM-dd HH:mm') } else { $null }); ` +
    `lastResult = $i.LastTaskResult; lastRun = $(if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('yyyy-MM-dd HH:mm') } else { $null }) } | ConvertTo-Json -Compress`;
  let r;
  try {
    r = await run(env.AGOUTI_POWERSHELL || "powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { env: windowsPowershellEnv(env) });
  } catch (err) {
    return { problem: `Couldn't ask Task Scheduler: ${err.message}` };
  }
  if (r.code !== 0) return { problem: `The task "${TASK}" isn't in Task Scheduler on this server.` };
  let t;
  try {
    t = JSON.parse(r.stdout);
  } catch {
    return { problem: `Couldn't read the task "${TASK}" from Task Scheduler.` };
  }
  for (const f of taskProgram(t.args)) {
    if (f && !existsSync(f)) return { problem: `${f} no longer exists (Node or Agouti was moved or removed).` };
  }
  if (t.state === "Disabled") return { problem: `The task "${TASK}" is disabled in Task Scheduler.` };
  return t.next ? { nextRun: t.next } : {};
}

// [node, agouti script] from the task's cmd arguments (see taskXml).
export function taskProgram(args) {
  const inner = String(args ?? "").replace(/^\/d \/s \/c "/, "").replace(/(?:set "[^"]*" && )*/, "");
  return splitWin(inner).slice(0, 2);
}

// Splits a command line written with winArg().
export function splitWin(line) {
  return [...String(line).matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(["\\])/g, "$1") : m[2]));
}
