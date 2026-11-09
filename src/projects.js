// Core "add an app" operations, shared by `agouti add` and the interactive app.
import { mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fsError, requireConfig, saveConfig } from "./config.js";
import { inspectDatabase, writeOptionFile } from "./mysql.js";
import { paths } from "./paths.js";
import { isWindows } from "./platform.js";
import { UserError } from "./ui.js";

export function optionFilePath(name, p = paths()) {
  return join(p.projectsDir, `${name}.cnf`);
}

export function validateName(name, config) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) return "Use lowercase letters, digits, - and _ (up to 40 characters).";
  if (config.projects?.[name]) return `There's already an app called "${name}".`;
  return true;
}

// The app directory must exist, and not already be backed up under another name.
export async function validateAppDir(dir, config) {
  if (!isAbsolute(dir)) dir = resolve(dir);
  dir = isWindows() ? normalize(dir).replace(/(?<!^[A-Za-z]:)\\+$/, "") : normalize(dir).replace(/\/+$/, "") || "/";
  let s;
  try {
    s = await stat(dir);
  } catch {
    throw new UserError(`${dir} doesn't exist.`);
  }
  if (!s.isDirectory()) throw new UserError(`${dir} isn't a directory.`);
  // Windows paths aren't case-sensitive: C:\Sites\Shop is c:\sites\shop.
  const same = (a, b) => (isWindows() ? a?.toLowerCase() === b.toLowerCase() : a === b);
  const taken = Object.entries(config.projects ?? {}).find(([, proj]) => same(proj.path, dir));
  if (taken) throw new UserError(`${dir} is already added as "${taken[0]}".`);
  return dir;
}

// Folders inside the app are stored relative to it (storage/app/public). A folder
// outside it (uploads kept in C:\SchoolClinic\data\uploads, /srv/shop-uploads) is
// given and stored as a full path. It can't hold the app itself, which would put the
// code in the backup and let a restore with --delete reach it.
export async function validateFolders(dir, folders) {
  const out = [];
  for (const f of folders.map((x) => x.trim()).filter(Boolean)) {
    const full = resolve(dir, f);
    const rel = relative(dir, full);
    const outside = rel.startsWith("..") || isAbsolute(rel);
    if (!rel) throw new UserError(`"${f}" is the app folder itself. Choose the folders inside it that hold uploaded files.`);
    if (outside && !isAbsolute(f)) {
      throw new UserError(`"${f}" isn't inside ${dir}.`, `For a folder outside the app, give its full path (${isWindows() ? "C:\\Data\\uploads" : "/srv/uploads"}).`);
    }
    if (outside && !relative(full, dir).startsWith("..") && !isAbsolute(relative(full, dir))) {
      throw new UserError(`${full} contains the app folder, so the app's code would be backed up too.`, "Choose the folder that holds the uploaded files.");
    }
    try {
      if (!(await stat(full)).isDirectory()) throw new Error();
    } catch {
      throw new UserError(`${full} isn't an existing folder.`);
    }
    // agouti.yml keeps / inside the app on every system (storage/app/public, not
    // storage\app\public); a folder outside keeps the system's own full path.
    const stored = outside ? stripTrailing(full) : isWindows() ? rel.replace(/\\/g, "/") : rel;
    if (!out.some((o) => samePath(o, stored))) out.push(stored);
  }
  return withoutNested(out);
}

const stripTrailing = (path) => path.replace(isWindows() ? /(?<!^[A-Za-z]:)[\\/]+$/ : /(?<!^)\/+$/, "");
// Windows paths aren't case-sensitive: C:\Data is c:\data.
const samePath = (a, b) => (isWindows() && isAbsolute(a) ? a.toLowerCase() === b.toLowerCase() : a === b);

// A folder inside another chosen folder is already backed up with it: keep only the
// outer one, so no file is in a backup twice. Relative folders use /, full paths the
// system's own separator.
export function withoutNested(folders) {
  const within = (f, o) => {
    if (isAbsolute(f) !== isAbsolute(o) || samePath(f, o)) return false;
    const sep = isAbsolute(o) && isWindows() ? "\\" : "/";
    const prefix = o.endsWith(sep) ? o : `${o}${sep}`;
    return isWindows() && isAbsolute(o) ? f.toLowerCase().startsWith(prefix.toLowerCase()) : f.startsWith(prefix);
  };
  return folders.filter((f) => !folders.some((o) => within(f, o)));
}

// Writes the app's credentials file and checks the connection with it.
export async function prepareDatabase(name, db, p = paths()) {
  try {
    await mkdir(p.projectsDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw fsError(err, p.projectsDir);
  }
  const file = optionFilePath(name, p);
  await writeOptionFile(file, db);
  return { file, check: await inspectDatabase(file, db.database) };
}

export async function discardDatabase(name, p = paths()) {
  await rm(optionFilePath(name, p), { force: true });
}

// Saves the app to agouti.yml. The password stays in the option file only.
export async function saveProject({ name, dir, framework, db, source, files, exclude }, p = paths()) {
  const config = await requireConfig(p);
  const valid = validateName(name, config);
  if (valid !== true) throw new UserError(valid);
  config.projects[name] = {
    path: dir,
    ...(framework ? { framework } : {}),
    database: {
      engine: "mysql",
      name: db.database,
      ...(db.socket ? { socket: db.socket } : { host: db.host, port: db.port }),
      user: db.username,
      credentials: optionFilePath(name, p),
      source,
    },
    files,
    ...(exclude?.length ? { exclude } : {}),
  };
  await saveConfig(config, p);
  return config.projects[name];
}
