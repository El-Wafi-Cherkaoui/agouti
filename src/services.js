// The service an app runs as (a Windows service, often through NSSM, or a systemd
// unit), so a restore that replaces live data can stop the app first and start it
// again after: otherwise the app keeps writing while its files and database change
// under it. Also: can the service's account still write into a restored folder?
import { spawnSync } from "node:child_process";
import { isAbsolute, normalize, relative } from "node:path";
import { isWindows, windowsPowershellEnv } from "./platform.js";
import { run } from "./restic.js";
import { UserError } from "./ui.js";

const systemctlBin = (env = process.env) => env.AGOUTI_SYSTEMCTL || "systemctl";
const POWERSHELL = "powershell.exe";

// Service names go to commands through the environment, never into a script's text;
// this only keeps out names that can't be real.
export function validateServiceName(name) {
  if (!/^[\w.@:-][\w .@:-]{0,255}$/.test(name ?? "")) return "That isn't a service name.";
  return true;
}

async function powershell(script, env = {}) {
  const r = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", `$ProgressPreference='SilentlyContinue'; ${script}`], {
    env: { ...windowsPowershellEnv(), ...env },
    timeout: 120000,
  });
  return r;
}

// ── Finding an app's service (Windows) ───────────────────────────────────────

// Every service with what it runs: NSSM keeps the real program and its folder in the
// service's Parameters key (Application, AppDirectory); other wrappers (WinSW,
// node-windows) put their own .exe inside the app folder.
const LIST_SERVICES = `
Get-CimInstance Win32_Service | ForEach-Object {
  $p = Get-ItemProperty -LiteralPath ("HKLM:\\SYSTEM\\CurrentControlSet\\Services\\" + $_.Name + "\\Parameters") -ErrorAction SilentlyContinue
  [pscustomobject]@{ name = $_.Name; display = $_.DisplayName; account = $_.StartName; state = $_.State; path = $_.PathName; appDirectory = $p.AppDirectory; application = $p.Application }
} | ConvertTo-Json -Compress`;

export async function findServices(dir) {
  if (!isWindows()) return [];
  const r = await powershell(LIST_SERVICES).catch(() => null);
  if (!r || r.code !== 0) return [];
  return servicesFor(dir, parseJsonList(r.stdout));
}

// The services that run the app in dir (pure, for tests).
export function servicesFor(dir, services) {
  const inside = (p) => {
    if (!p) return false;
    const rel = relative(dir.toLowerCase(), normalize(p).toLowerCase());
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  return services
    .filter((s) => inside(s.appDirectory) || inside(exeOf(s.path)))
    .map((s) => ({ name: s.name, display: s.display, account: s.account, running: s.state === "Running" }));
}

// "C:\app\nssm.exe" or C:\app\nssm.exe -arg → C:\app\nssm.exe
function exeOf(pathName) {
  if (!pathName) return null;
  const m = pathName.match(/^\s*"([^"]+)"/) ?? pathName.match(/^\s*(\S+\.exe)\b/i);
  return m ? m[1] : null;
}

function parseJsonList(text) {
  try {
    const v = JSON.parse(text || "[]");
    return Array.isArray(v) ? v : v ? [v] : [];
  } catch {
    return [];
  }
}

// ── State, stop, start ───────────────────────────────────────────────────────

// { exists, running, account }
export async function serviceStatus(name, env = process.env) {
  if (isWindows()) {
    const r = await powershell(
      "Get-CimInstance Win32_Service | Where-Object Name -eq $env:AGOUTI_SERVICE | Select-Object Name, State, StartName | ConvertTo-Json -Compress",
      { AGOUTI_SERVICE: name },
    );
    if (r.code !== 0) throw new UserError(`Couldn't look up the service ${name}: ${r.stderr.trim()}`);
    const [s] = parseJsonList(r.stdout);
    return s ? { exists: true, running: s.State === "Running", account: s.StartName } : { exists: false };
  }
  const r = await run(systemctlBin(env), ["show", name, "--property=LoadState,ActiveState,User"], { env });
  if (r.code !== 0) throw new UserError(`Couldn't look up the service ${name}: ${r.stderr.trim()}`);
  const v = Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  if (v.LoadState === "not-found") return { exists: false };
  return { exists: true, running: v.ActiveState === "active" || v.ActiveState === "activating", account: v.User || "root" };
}

export async function stopService(name, env = process.env) {
  const r = isWindows()
    ? await powershell("Stop-Service -Name $env:AGOUTI_SERVICE -Force -ErrorAction Stop", { AGOUTI_SERVICE: name })
    : await run(systemctlBin(env), ["stop", name], { env });
  if (r.code !== 0) throw new UserError(`Couldn't stop the service ${name}: ${lastLine(r.stderr) || `exit code ${r.code}`}`);
}

export async function startService(name, env = process.env) {
  const r = isWindows()
    ? await powershell("Start-Service -Name $env:AGOUTI_SERVICE -ErrorAction Stop", { AGOUTI_SERVICE: name })
    : await run(systemctlBin(env), ["start", name], { env });
  if (r.code !== 0) throw new UserError(`Couldn't start the service ${name}: ${lastLine(r.stderr) || `exit code ${r.code}`}`);
}

// For the Ctrl-C path, which can't wait for promises.
export function startServiceSync(name, env = process.env) {
  const r = isWindows()
    ? spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", "Start-Service -Name $env:AGOUTI_SERVICE"], { env: { ...windowsPowershellEnv(), AGOUTI_SERVICE: name }, stdio: "ignore", timeout: 60000, windowsHide: true })
    : spawnSync(systemctlBin(env), ["start", name], { env, stdio: "ignore", timeout: 60000 });
  return r.status === 0;
}

export function startCommand(name) {
  return isWindows() ? `Start-Service ${name}` : `sudo systemctl start ${name}`;
}

const lastLine = (s) => s.trim().split("\n").filter(Boolean).at(-1)?.trim() ?? "";

// ── Can the service's account write here? (Windows) ──────────────────────────

const ALIASES = {
  WD: "S-1-1-0", // Everyone
  AU: "S-1-5-11", // Authenticated Users
  BU: "S-1-5-32-545", // Users
  BA: "S-1-5-32-544", // Administrators
  SU: "S-1-5-6", // SERVICE (every service's token has it)
  SY: "S-1-5-18", // LocalSystem
  LS: "S-1-5-19", // LocalService
  NS: "S-1-5-20", // NetworkService
  CO: "S-1-3-0", // the file's creator
};

// A service account's own SID and the built-in groups every service token holds.
// Names are as Windows writes StartName; they aren't translated, unlike icacls's output.
export function accountSids(account) {
  const a = (account ?? "").toLowerCase().replace(/^\.\\/, "");
  const own = {
    localsystem: ALIASES.SY,
    "nt authority\\system": ALIASES.SY,
    "nt authority\\networkservice": ALIASES.NS,
    "nt authority\\network service": ALIASES.NS,
    "nt authority\\localservice": ALIASES.LS,
    "nt authority\\local service": ALIASES.LS,
  }[a];
  if (!own) return null; // another user: its groups aren't known here
  return [own, ALIASES.WD, ALIASES.AU, ALIASES.BU, ALIASES.SU, ...(own === ALIASES.SY ? [ALIASES.BA] : [])];
}

// Rights, from an ACE's SDDL text: a hex mask or two-letter codes.
const RIGHTS = { FA: 0x1f01ff, FW: 0x120116, GA: 0x10000000, GW: 0x40000000, DC: 0x2, CC: 0x1, LC: 0x4, SW: 0x8, RP: 0x10, WP: 0x20, DT: 0x40, LO: 0x80, CR: 0x100 };
const writes = (mask) => Boolean(mask & 0x2) || Boolean(mask & 0x10000000) || Boolean(mask & 0x40000000);
function maskOf(text) {
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  let m = 0;
  for (let i = 0; i < text.length; i += 2) m |= RIGHTS[text.slice(i, i + 2)] ?? 0;
  return m;
}

// Can one of these SIDs create and change files in the folder (and its files), going by
// the folder's SDDL? A deny entry for any of them wins. Pure, for tests.
export function canWrite(sddl, sids) {
  const dacl = sddl.slice(sddl.indexOf("D:") + 2).replace(/S:.*$/, "");
  const aces = [...dacl.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(";"));
  let allowFolder = false;
  let allowFiles = false;
  for (const [type, flags, rights, , , trustee] of aces) {
    const sid = ALIASES[trustee] ?? trustee;
    if (!sids.includes(sid) || !writes(maskOf(rights))) continue;
    const forFolder = !flags.includes("IO");
    const forFiles = flags.includes("OI");
    if (type === "D") return false;
    if (type === "A") {
      allowFolder ||= forFolder;
      allowFiles ||= forFiles;
    }
  }
  return allowFolder && allowFiles;
}

// For each folder: { folder, ok: true }, { folder, ok: false, fix } with the icacls
// command that grants the account Modify there, or { folder, ok: null, error } when its
// permissions couldn't be read. null when it can't be told (another account, not Windows).
export async function checkWriteAccess(folders, account) {
  if (!isWindows()) return null;
  const sids = accountSids(account);
  if (!sids) return null;
  const out = [];
  for (const folder of folders) {
    const r = await powershell("(Get-Acl -LiteralPath $env:AGOUTI_FOLDER -ErrorAction Stop).Sddl", { AGOUTI_FOLDER: folder }).catch((err) => ({ code: -1, stderr: err.message }));
    if (r.code !== 0 || !r.stdout.includes("D:")) {
      out.push({ folder, ok: null, error: lastLine(r.stderr) || "no permissions returned" });
      continue;
    }
    const ok = canWrite(r.stdout.trim(), sids);
    out.push(ok ? { folder, ok } : { folder, ok, fix: grantCommand(folder, sids[0]) });
  }
  return out;
}

export function grantCommand(folder, sid) {
  return `icacls "${folder}" /grant "*${sid}:(OI)(CI)M"`;
}

export function grantAccess(folder, sid) {
  const r = spawnSync("icacls", [folder, "/grant", `*${sid}:(OI)(CI)M`], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new UserError(`Couldn't change the permissions of ${folder}: ${(r.stderr || r.stdout || "").trim()}`);
}
