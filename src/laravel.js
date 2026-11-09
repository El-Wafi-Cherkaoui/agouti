// Laravel caches query results (Cache::remember) outside the database, so after a
// replace the app can keep serving data from before the restore until the cache
// expires. Clearing it is part of putting the app back.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// Runs `php artisan cache:clear` as the app's owner, never as root: artisan run as
// root can leave root-owned cache files the app can't write. { ok, owner, error }.
export async function clearLaravelCache(dir, { php = process.env.AGOUTI_PHP, timeout = 120_000 } = {}) {
  const windows = process.platform === "win32";
  const { uid, gid } = await stat(join(dir, "artisan")).catch(() => stat(dir));
  // Windows has no file owner to switch to: artisan runs as this administrator.
  const { name: owner, home } = windows ? { name: process.env.USERNAME || "administrator" } : await user(uid);
  php ??= await findPhp(home);
  if (!php) {
    return {
      ok: false,
      owner,
      error: windows ? "php.exe wasn't found (not on the PATH, nor in C:\\Program Files\\PHP or C:\\PHP)" : "php wasn't found (sudo doesn't pass on your PATH, and it isn't in the usual places)",
    };
  }
  const asOwner = process.getuid?.() === 0 && uid !== 0 ? { uid, gid } : {};
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(php, ["artisan", "cache:clear", "--no-interaction"], {
      windowsHide: true,
      cwd: dir,
      env: { ...process.env, ...(asOwner.uid !== undefined ? { HOME: dir } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      ...asOwner,
    });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ ok: false, owner, error: err.message }));
    child.on("close", (code) => {
      const last = out.trim().split("\n").filter(Boolean).at(-1)?.trim() ?? "";
      resolve(code === 0 ? { ok: true, owner } : { ok: false, owner, error: last || `exit code ${code}` });
    });
  });
}

async function user(uid) {
  const passwd = await readFile("/etc/passwd", "utf8").catch(() => "");
  const f = passwd.split("\n").find((l) => l.split(":")[2] === String(uid))?.split(":");
  return { name: f?.[0] ?? `uid ${uid}`, home: f?.[5] };
}

// Agouti runs under sudo, which replaces the PATH with a few system folders, so a
// php installed per user (Laravel Herd, php.new) isn't found by name. Look where
// it usually is: the PATH, the app owner's home, then the system.
export async function findPhp(home, { path = process.env.PATH ?? "" } = {}) {
  if (process.platform === "win32") return findPhpWindows(path);
  const candidates = [
    ...path.split(":").filter(Boolean).map((d) => join(d, "php")),
    ...(home ? [join(home, ".config/herd-lite/bin/php"), join(home, ".config/herd/bin/php"), join(home, ".local/bin/php")] : []),
    "/usr/bin/php",
    "/usr/local/bin/php",
  ];
  for (const c of candidates) {
    if (await access(c, constants.X_OK).then(() => true, () => false)) return c;
  }
  return null;
}

// Windows: on the PATH, else where IIS installs usually put it (Web Platform
// Installer: C:\Program Files\PHP\v8.2\php.exe; by hand: C:\PHP\php.exe), newest first.
async function findPhpWindows(path) {
  const candidates = path.split(";").filter(Boolean).map((d) => join(d, "php.exe"));
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\"].filter(Boolean)) {
    const base = join(root, "PHP");
    candidates.push(join(base, "php.exe"));
    const versions = await readdir(base).catch(() => []);
    for (const v of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) candidates.push(join(base, v, "php.exe"));
  }
  for (const c of candidates) {
    if (await access(c, constants.F_OK).then(() => true, () => false)) return c;
  }
  return null;
}
