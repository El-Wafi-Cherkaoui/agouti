// Core "add an app" operations, shared by `agouti add` and the interactive app.
import { mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fsError, requireConfig, saveConfig } from "./config.js";
import { inspectDatabase, writeOptionFile } from "./mysql.js";
import { paths } from "./paths.js";
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
  dir = normalize(dir).replace(/\/+$/, "") || "/";
  let s;
  try {
    s = await stat(dir);
  } catch {
    throw new UserError(`${dir} doesn't exist.`);
  }
  if (!s.isDirectory()) throw new UserError(`${dir} isn't a directory.`);
  const taken = Object.entries(config.projects ?? {}).find(([, proj]) => proj.path === dir);
  if (taken) throw new UserError(`${dir} is already added as "${taken[0]}".`);
  return dir;
}

// Folders are stored relative to the app, and must stay inside it.
export async function validateFolders(dir, folders) {
  const out = [];
  for (const f of folders.map((x) => x.trim()).filter(Boolean)) {
    const rel = relative(dir, resolve(dir, f));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new UserError(`"${f}" must be a folder inside ${dir}.`);
    try {
      if (!(await stat(join(dir, rel))).isDirectory()) throw new Error();
    } catch {
      throw new UserError(`${join(dir, rel)} isn't an existing folder.`);
    }
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
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
