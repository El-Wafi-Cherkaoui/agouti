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
import { UserError } from "./ui.js";

export const TIMER = "agouti-backup.timer";
export const SERVICE = "agouti-backup.service";

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
