// What differs between Linux and Windows servers, in one place. Everything takes
// the platform as an option so the Windows rules can be tested on Linux too.
//
// Paths: on Windows, restic records the folders it backed up as given (C:\inetpub\shop),
// but inside a snapshot every path is written /C/inetpub/shop, and that's the form
// `restic restore <id>:<folder>`, `restic ls <id> <path>` and listings use.
// Patterns: restic matches --exclude/--include like Go's filepath.Match, which has
// no escape character on Windows (\ is the separator there).
import { spawnSync } from "node:child_process";
import { posix, win32 } from "node:path";

export const isWindows = (platform = process.platform) => platform === "win32";
export const pathFor = (platform = process.platform) => (isWindows(platform) ? win32 : posix);

// C:\inetpub\shop -> /C/inetpub/shop (Windows); unchanged elsewhere.
export function toSnapshotPath(path, platform = process.platform) {
  if (!isWindows(platform)) return path;
  const m = String(path).match(/^([A-Za-z]):[\\/]*(.*)$/);
  if (!m) return String(path).replace(/\\/g, "/");
  const rest = m[2].replace(/\\/g, "/").replace(/\/+$/, "");
  return `/${m[1].toUpperCase()}${rest ? `/${rest}` : ""}`;
}

// /C/inetpub/shop -> C:\inetpub\shop (Windows); unchanged elsewhere.
export function fromSnapshotPath(path, platform = process.platform) {
  if (!isWindows(platform)) return path;
  const m = String(path).match(/^\/([A-Za-z])(?:\/(.*))?$/);
  if (!m) return String(path).replace(/\//g, "\\");
  return `${m[1]}:\\${(m[2] ?? "").replace(/\//g, "\\")}`;
}

// A path written so restic's pattern matching reads it literally. Linux: \-escapes.
// Windows: forward slashes (restic accepts them) and [[] for [ (Windows names can't
// hold * or ?).
export function escapePattern(path, platform = process.platform) {
  if (!isWindows(platform)) return path.replace(/[\\*?[\]]/g, "\\$&");
  return path.replace(/\\/g, "/").replace(/[[*?]/g, "[$&]");
}

// relative(), always with / (how agouti.yml stores folders, on every system).
export function relativePosix(from, to, platform = process.platform) {
  const rel = pathFor(platform).relative(from, to);
  return isWindows(platform) ? rel.replace(/\\/g, "/") : rel;
}

// Is this process allowed to manage Agouti's folders? Root on Linux; on Windows,
// an elevated ("Run as administrator") session or the SYSTEM account.
export function isAdmin(platform = process.platform) {
  if (!isWindows(platform)) return process.getuid?.() === 0;
  // `net session` needs administrator rights; fltmc too, and still works when the
  // Server service (which net session talks to) is stopped.
  const ok = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore", windowsHide: true, timeout: 10000 }).status === 0;
  return ok("net", ["session"]) || ok("fltmc", []);
}

// Windows: only Administrators and SYSTEM may read the folder (it holds the
// recovery key and database passwords). ProgramData is readable by every user by
// default, and file modes like 0600 mean nothing there. Linux: nothing to do, files
// are created with their mode. Returns an error message, or null.
export function makePrivate(dir, platform = process.platform) {
  if (!isWindows(platform)) return null;
  // SIDs, not names: "Administrators" is called otherwise on a French or German Windows.
  const r = spawnSync("icacls", [dir, "/inheritance:r", "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "/Q"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  return r.status === 0 ? null : (r.stderr || r.stdout || r.error?.message || `icacls exit code ${r.status}`).trim();
}

// How people run Agouti with full rights, in hints and messages.
export const adminWord = (platform = process.platform) => (isWindows(platform) ? "an Administrator terminal" : "sudo");
