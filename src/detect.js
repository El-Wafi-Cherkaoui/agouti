// Finds out what kind of app lives in a directory and which folders hold its
// uploaded files. Reads only structure (file names, composer.json/lock, package.json), never .env.
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function detectApp(dir) {
  const composer = await readJson(join(dir, "composer.json"));
  const requiresLaravel = composer?.require?.["laravel/framework"];
  if (requiresLaravel && (await exists(join(dir, "artisan")))) {
    return { framework: "laravel", label: `Laravel ${await laravelVersion(dir)}`.trim(), envFile: join(dir, ".env") };
  }
  // Node: a package.json with something to run. Next.js is told apart (its own
  // public/ folder is where such apps tend to keep uploads).
  const pkg = await readJson(join(dir, "package.json"));
  if (pkg && (pkg.dependencies || pkg.scripts || pkg.main)) {
    const env = (await exists(join(dir, ".env"))) ? join(dir, ".env") : null;
    const next = pkg.dependencies?.next ?? pkg.devDependencies?.next;
    if (next) return { framework: "nextjs", label: `Next.js ${majorOf(next)}`.trim(), envFile: env };
    return { framework: "node", label: "Node.js app", envFile: env };
  }
  return { framework: null, label: "Unknown framework", envFile: (await exists(join(dir, ".env"))) ? join(dir, ".env") : null };
}

async function laravelVersion(dir) {
  const lock = await readJson(join(dir, "composer.lock"));
  const pkg = lock?.packages?.find((p) => p.name === "laravel/framework");
  return pkg?.version?.replace(/^v/, "").split(".")[0] ?? "";
}

// "^14.2.3" → "14", "latest" → "".
const majorOf = (range) => String(range).match(/\d+/)?.[0] ?? "";

// Where Node apps usually keep uploaded files. Only folders that exist are offered;
// public/ itself isn't, since it's mostly the app's own images and icons.
const NODE_UPLOADS = ["uploads", "public/uploads", "storage", "storage/uploads", "data", "data/uploads", "files", "media"];

// Folders to offer for backup, with a default on/off choice and a reason.
export async function fileCandidates(dir, framework) {
  if (framework === "node" || framework === "nextjs") {
    const out = [];
    for (const path of NODE_UPLOADS) if ((await stat(join(dir, path)).catch(() => null))?.isDirectory()) out.push({ path, include: true });
    if (await exists(join(dir, "logs"))) out.push({ path: "logs", include: false, reason: "logs" });
    return out;
  }
  if (framework !== "laravel") return [];
  const out = [];
  // Each folder under storage/app is a disk (public, private, or custom ones).
  const disks = await subdirs(join(dir, "storage/app"));
  for (const name of disks) out.push({ path: `storage/app/${name}`, include: true });
  // Older Laravel keeps private files directly in storage/app. Backing up that folder
  // means all of it, the disks above included (and anything else in there, such as
  // an app's own backups), so with disks it's offered but not chosen.
  if (await hasLooseFiles(join(dir, "storage/app"))) {
    out.push(
      disks.length
        ? { path: "storage/app", include: false, whole: true, note: "the whole folder, the ones above included" }
        : { path: "storage/app", include: true, note: "files directly inside" },
    );
  }
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
// A folder that isn't an app itself is looked into once more: a project often keeps
// its backend in a subfolder (iso-cloud\backend beside iso-cloud\frontend).
export async function findApps(roots = (process.env.AGOUTI_APP_ROOTS ?? APP_ROOTS).split(process.platform === "win32" ? ";" : ":")) {
  const apps = [];
  for (const root of roots) {
    for (const name of await subdirs(root)) {
      const dir = join(root, name);
      const app = await detectApp(dir);
      if (app.framework) {
        apps.push({ dir, ...app });
        continue;
      }
      for (const sub of await subdirs(dir)) {
        if (["node_modules", "vendor"].includes(sub)) continue;
        const inner = await detectApp(join(dir, sub));
        if (inner.framework) apps.push({ dir: join(dir, sub), ...inner });
      }
    }
  }
  return apps;
}

// A config-friendly name from a directory: "/var/www/My Shop" → "my-shop". A
// generic folder name takes its project's: iso-cloud\backend → "iso-cloud".
const GENERIC = ["backend", "api", "server", "app", "src", "web", "site"];
export function suggestName(dir) {
  const name = GENERIC.includes(basename(dir).toLowerCase()) && basename(dirname(dir)) ? basename(dirname(dir)) : basename(dir);
  return (
    name
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
