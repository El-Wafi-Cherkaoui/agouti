// Finds out what kind of app lives in a directory and which folders hold its
// uploaded files. Reads only structure (file names, composer.json/lock), never .env.
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export async function detectApp(dir) {
  const composer = await readJson(join(dir, "composer.json"));
  const requiresLaravel = composer?.require?.["laravel/framework"];
  if (requiresLaravel && (await exists(join(dir, "artisan")))) {
    return { framework: "laravel", label: `Laravel ${await laravelVersion(dir)}`.trim(), envFile: join(dir, ".env") };
  }
  return { framework: null, label: "Unknown framework", envFile: (await exists(join(dir, ".env"))) ? join(dir, ".env") : null };
}

async function laravelVersion(dir) {
  const lock = await readJson(join(dir, "composer.lock"));
  const pkg = lock?.packages?.find((p) => p.name === "laravel/framework");
  return pkg?.version?.replace(/^v/, "").split(".")[0] ?? "";
}

// Folders to offer for backup, with a default on/off choice and a reason.
export async function fileCandidates(dir, framework) {
  if (framework !== "laravel") return [];
  const out = [];
  // Each folder under storage/app is a disk (public, private, or custom ones).
  for (const name of await subdirs(join(dir, "storage/app"))) {
    out.push({ path: `storage/app/${name}`, include: true });
  }
  // Older Laravel keeps private files directly in storage/app.
  if (await hasLooseFiles(join(dir, "storage/app"))) out.push({ path: "storage/app", include: true, note: "files directly inside" });
  for (const [path, reason] of [
    ["storage/logs", "logs"],
    ["storage/framework", "cache"],
    ["bootstrap/cache", "cache"],
  ]) {
    if (await exists(join(dir, path))) out.push({ path, include: false, reason });
  }
  return out;
}

// Size and file count, without following symlinks (public/storage links back into storage/app/public).
// Paths stay as bytes: a file name that isn't valid UTF-8 can't be found again once decoded to a string.
export async function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true, encoding: "buffer" });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = Buffer.concat([d, Buffer.from("/"), e.name]);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        files++;
        // A file can vanish while we measure (a live app): that's not worth stopping for.
        bytes += (await lstat(full).catch(() => null))?.size ?? 0;
      }
    }
  };
  await walk(Buffer.from(dir));
  return { bytes, files };
}

// Where web apps usually live. Windows: IIS, XAMPP and Laragon folders.
const APP_ROOTS = process.platform === "win32" ? "C:\\inetpub\\wwwroot;C:\\xampp\\htdocs;C:\\laragon\\www" : "/var/www:/srv";

// Apps under the usual web roots, to offer as choices. AGOUTI_APP_ROOTS overrides (tests).
export async function findApps(roots = (process.env.AGOUTI_APP_ROOTS ?? APP_ROOTS).split(process.platform === "win32" ? ";" : ":")) {
  const apps = [];
  for (const root of roots) {
    for (const name of await subdirs(root)) {
      const dir = join(root, name);
      const app = await detectApp(dir);
      if (app.framework) apps.push({ dir, ...app });
    }
  }
  return apps;
}

// A config-friendly name from a directory: "/var/www/My Shop" → "my-shop".
export function suggestName(dir) {
  return (
    basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

export function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

async function subdirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function hasLooseFiles(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).some((e) => e.isFile() && e.name !== ".gitignore");
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
