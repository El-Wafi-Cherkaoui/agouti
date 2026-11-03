// Restoring restore points. Two modes:
//   copy     (default) the database goes into a new database next to the live
//            one, files into a folder under /var/lib/agouti/restores. Nothing
//            live is touched, so it's always safe to try.
//   replace  the live database and folders are replaced. A safety restore point
//            of the current state is made first, so a replace can be undone.
// No printing here: progress and results go to onEvent.
import { shield, spawn, stopAll } from "./children.js";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readdir, rm, statfs } from "node:fs/promises";
import { join, relative } from "node:path";
import { APP_FILE, backupApps } from "./backup.js";
import { requireConfig, writeAtomic } from "./config.js";
import { cleanError, id, mysqlClient, optionFileContent, query, str } from "./mysql.js";
import { paths } from "./paths.js";
import { ensureRestic, resticEnv, run, runJson } from "./restic.js";
import { acquireLock, lockFile } from "./state.js";
import { UserError } from "./ui.js";

// Restore points of one app, newest first:
// [{ id, at, database: { snapshot, path, bytes } | null, files: { snapshot, paths, files, bytes } | null }]
export async function listPoints(app, { bin, env }) {
  const r = await run(bin, ["snapshots", "--json", "--tag", `agouti,app=${app}`], { env });
  if (r.code !== 0) throw new UserError(`Couldn't list restore points: ${cleanRestic(r.stderr)}`);
  const points = new Map();
  for (const s of JSON.parse(r.stdout || "[]") ?? []) {
    const tag = (name) => s.tags?.find((t) => t.startsWith(`${name}=`))?.slice(name.length + 1);
    const point = tag("point");
    if (!point) continue;
    const pt = points.get(point) ?? { id: point, at: s.time, database: null, files: null, safety: s.tags.includes("kind=safety") };
    if (s.time < pt.at) pt.at = s.time;
    const sum = s.summary ?? {};
    if (tag("part") === "database") pt.database = { snapshot: s.id, path: s.paths[0], bytes: sum.total_bytes_processed };
    if (tag("part") === "files") pt.files = { snapshot: s.id, paths: s.paths, files: sum.total_files_processed, bytes: sum.total_bytes_processed };
    points.set(point, pt);
  }
  return [...points.values()].sort((a, b) => b.id.localeCompare(a.id));
}

// Apps that have backups in the repository, from their latest description (see
// appDescription in backup.js). Used on a new server, after `agouti connect`.
// [{ name, host, at, points, description }], newest first.
export async function discoverApps({ bin, env }) {
  const r = await run(bin, ["snapshots", "--json", "--tag", "agouti"], { env });
  if (r.code !== 0) throw new UserError(`Couldn't read the backups: ${cleanRestic(r.stderr)}`);
  const apps = new Map();
  for (const s of JSON.parse(r.stdout || "[]") ?? []) {
    const tag = (name) => s.tags?.find((t) => t.startsWith(`${name}=`))?.slice(name.length + 1);
    const name = tag("app");
    if (!name || s.tags.includes("kind=safety")) continue;
    const app = apps.get(name) ?? { name, host: s.hostname, at: s.time, points: new Set(), describedBy: null, snapshots: [] };
    app.points.add(tag("point"));
    if (s.time >= app.at) Object.assign(app, { at: s.time, host: s.hostname });
    if (tag("part") === "app" && (!app.describedBy || s.time > app.describedBy.time)) app.describedBy = s;
    app.snapshots.push(s);
    apps.set(name, app);
  }
  const found = [];
  for (const app of apps.values()) {
    let description = null;
    if (app.describedBy) {
      const d = await run(bin, ["dump", app.describedBy.id, `/${APP_FILE}`], { env });
      if (d.code === 0) description = JSON.parse(d.stdout);
    }
    // Backups made before descriptions existed: work it out from the snapshots.
    description ??= guessDescription(app);
    found.push({ name: app.name, host: app.host, at: app.at, points: app.points.size, description });
  }
  return found.sort((a, b) => b.at.localeCompare(a.at));
}

function guessDescription(app) {
  const latest = (part) => app.snapshots.filter((s) => s.tags.includes(`part=${part}`)).sort((a, b) => b.time.localeCompare(a.time))[0];
  const db = latest("database");
  const folders = latest("files")?.paths ?? [];
  // The app's folder: above storage/ (Laravel), else the folders' common parent.
  const common = folders.length ? folders.reduce((a, b) => commonDir(a, b)) : "";
  const path = common.includes("/storage") ? common.slice(0, common.indexOf("/storage")) : common;
  return {
    app: app.name,
    path,
    database: { engine: "mysql", name: db ? db.paths[0].replace(/^\//, "").replace(/\.sql$/, "") : app.name },
    files: folders.map((f) => relative(path, f)),
    guessed: true,
  };
}

function commonDir(a, b) {
  const x = a.split("/");
  const y = b.split("/");
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return x.slice(0, i).join("/") || "/";
}

const cleanRestic = (stderr) =>
  stderr
    .trim()
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l).message ?? l;
      } catch {
        return l;
      }
    })
    .at(-1)
    ?.replace(/^Fatal: /, "") ?? "";

// "shop_prod" + "20261103T030000Z" -> "shop_prod_restored_20261103_0300" (max 64 chars).
export function copyDatabaseName(database, pointId) {
  const suffix = `_restored_${pointId.slice(0, 8)}_${pointId.slice(9, 13)}`;
  return database.slice(0, 64 - suffix.length) + suffix;
}

export function copyFolder(p, app, pointId) {
  return join(p.dataDir, "restores", `${app}-${pointId}`);
}

// Restoring a database needs a user that can create and drop databases; the
// read-only backup user can't. By default: root through the local socket (how
// MySQL and MariaDB are set up on Debian and Ubuntu: root on the server is root
// in MySQL). Or a given admin user. Writes a temporary root-only option file.
export async function adminConnection(project, { user, password, host, port, p = paths() } = {}) {
  const db = project.database;
  const local = db.socket || ["localhost", "127.0.0.1", "::1"].includes(db.host);
  if (!user && !local) {
    throw new UserError(
      `The database of this app is on another server (${db.host}).`,
      "Give a MySQL user that can create databases: --db-admin-user <user>, password in AGOUTI_DB_ADMIN_PASSWORD.",
    );
  }
  // Only one restore runs at a time (the lock), so any other such file is left
  // over from a run that was killed: it holds a password, remove it.
  for (const f of await readdir(p.dataDir).catch(() => [])) if (/^restore-admin-\d+\.cnf$/.test(f)) await rm(join(p.dataDir, f), { force: true });
  const file = join(p.dataDir, `restore-admin-${process.pid}.cnf`);
  const conn = user
    ? { username: user, password, socket: host ? undefined : db.socket, host: host ?? db.host, port: port ?? db.port ?? 3306 }
    : { username: "root", password: "", socket: db.socket, host: "localhost", port: db.port ?? 3306 };
  await mkdir(p.dataDir, { recursive: true });
  await writeAtomic(file, optionFileContent(conn), 0o600);
  const test = await query(file, "SELECT CURRENT_USER()");
  if (!test.ok) {
    await rm(file, { force: true });
    if (test.missing) throw new UserError("The mysql client isn't installed.", "Install it (e.g. `apt install mysql-client`) and try again.");
    throw new UserError(
      user ? `Can't connect as ${user}: ${test.error}` : `Can't connect as MySQL root on this server: ${test.error}`,
      "Restoring needs a MySQL user that can create databases. Give one with --db-admin-user (password in AGOUTI_DB_ADMIN_PASSWORD).",
    );
  }
  const onExit = () => rmSync(file, { force: true });
  process.on("exit", onExit);
  return {
    file,
    user: test.rows[0]?.[0] ?? conn.username,
    cleanup: async () => {
      process.off("exit", onExit);
      await rm(file, { force: true });
    },
  };
}

// Restores the given parts of one point.
// opts: { app, point (id or "latest"), parts: ["database", "files"], mode, admin: { user, password } }
// mode: "copy" | "replace" (an app of this server), or "new": an app found in the
// backups but not set up here (a new server). opts.project then says where it goes,
// opts.origin where it was. "new" only writes into an empty database and empty folders.
export async function restoreApp(opts, { p = paths(), onEvent = () => {}, log } = {}) {
  const { app, parts = ["database", "files"], mode = "copy" } = opts;
  const config = await requireConfig(p);
  const project = mode === "new" ? opts.project : config.projects?.[app];
  if (!project) throw new UserError(`Unknown app: ${app}`, `Apps: ${Object.keys(config.projects ?? {}).join(", ") || "none yet"}`);
  const origin = opts.origin ?? project.path;

  const release = await acquireLock(p);
  let admin;
  const state = { safety: null, touchingLive: false };
  const unguard = guardInterrupts(state, {
    app,
    onEvent,
    cleanup: () => {
      if (admin) rmSync(admin.file, { force: true });
      rmSync(lockFile(p), { force: true });
    },
  });
  try {
    const bin = await ensureRestic({ p, log });
    const env = await resticEnv(config, p);
    const points = await listPoints(app, { bin, env });
    if (!points.length) throw new UserError(`${app} has no restore points yet.`, `Make one: sudo agouti backup ${app}`);
    const point = !opts.point || opts.point === "latest" ? points[0] : points.find((pt) => pt.id === opts.point);
    if (!point) throw new UserError(`No restore point ${opts.point} for ${app}.`, `See them: sudo agouti restore ${app} --list`);
    for (const part of parts) {
      if (!point[part]) throw new UserError(`Restore point ${point.id} has no ${part} (that part of the backup failed).`, "Pick another restore point.");
    }

    // Connect first, so a missing admin user fails before anything else happens.
    if (parts.includes("database")) admin = await adminConnection(project, { ...opts.admin, p });

    // A copy never overwrites anything, including an earlier copy: check before doing any work.
    if (mode === "copy") {
      const folder = copyFolder(p, app, point.id);
      if (parts.includes("files") && (await readdir(folder).catch(() => [])).length) {
        throw new UserError(`${folder} already exists (restored earlier?).`, `Delete it first if you don't need it: rm -r ${folder}`);
      }
      const db = copyDatabaseName(project.database.name, point.id);
      if (parts.includes("database") && (await query(admin.file, `SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${str(db)}`)).rows?.length) {
        throw new UserError(`The database ${db} already exists (restored earlier?).`, `Drop it first if you don't need it: DROP DATABASE ${id(db)};`);
      }
    }

    // New server: never overwrite anything that's already there.
    if (mode === "new") {
      if (parts.includes("database")) {
        const name = project.database.name;
        const [[tables] = []] = (await query(admin.file, `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${str(name)}`)).rows ?? [];
        if (Number(tables) > 0) throw new UserError(`The database ${name} already exists on this server and has tables.`, "Choose another database name.");
      }
      if (parts.includes("files")) {
        for (const folder of point.files.paths) {
          const dest = destination(folder, origin, project.path);
          if (await hasFiles(dest)) throw new UserError(`${dest} already has files.`, "Restore into an empty folder, or choose another directory.");
        }
      }
    }

    const result = { app, point: point.id, at: point.at, mode, ok: true };
    if (mode === "replace") {
      onEvent({ type: "safety-start", app });
      const [safety] = await backupApps([app], { p, lock: false, log, tags: ["kind=safety"] });
      result.safety = safety;
      state.safety = safety.ok ? safety.point : null;
      onEvent({ type: "safety-done", app, result: safety });
      const broken = parts.filter((part) => !safety[part].ok);
      if (broken.length) {
        throw new UserError(
          `Couldn't save the current ${broken.join(" and ")} first, so nothing was replaced.`,
          `${safety[broken[0]].error}. You can still restore as a copy.`,
        );
      }
    }

    state.touchingLive = mode !== "copy";
    for (const part of parts) {
      // Replacing: after a failed part, stop. Undo with the safety point rather than pile on changes.
      if (mode === "replace" && !result.ok) break;
      onEvent({ type: "part-start", part });
      const started = Date.now();
      let r;
      try {
        r =
          part === "database"
            ? await restoreDatabase(point, project, { bin, env, admin, mode, onEvent })
            : await restoreFiles(point, project, { bin, env, mode, origin, target: copyFolder(p, app, point.id), onEvent });
      } catch (err) {
        r = { ok: false, error: err.message, hint: err.hint };
      }
      r.seconds = Math.round((Date.now() - started) / 100) / 10;
      result[part] = r;
      if (!r.ok) result.ok = false;
      onEvent({ type: "part-done", part, result: r });
    }
    return result;
  } finally {
    unguard();
    await admin?.cleanup();
    await release();
  }
}

// While a restore runs: Ctrl-C, a closed SSH session or `kill` must not leave live
// data half-restored without telling how to recover. Children run shielded (their
// own process group). Copy mode: Ctrl-C stops at once (nothing live was touched).
// Replace mode: the first Ctrl-C only warns, the second stops and says how to undo.
function guardInterrupts(state, { app, onEvent, cleanup }) {
  shield(true);
  let warned = false;
  const stop = (signal) => {
    if (signal === "SIGINT" && state.touchingLive && !warned) {
      warned = true;
      onEvent({ type: "interrupt-warning" });
      return;
    }
    stopAll();
    cleanup();
    onEvent({ type: "stopped", touchedLive: state.touchingLive, safety: state.safety, app });
    process.exit(130);
  };
  const ignore = () => {};
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", ignore); // the SSH session dropped: finish the restore anyway
  process.stdout.on("error", ignore); // ...even though nobody can read the output any more
  return () => {
    shield(false);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", ignore);
    process.stdout.off("error", ignore);
  };
}

async function restoreDatabase(point, project, { bin, env, admin, mode, onEvent }) {
  const live = project.database.name;
  const target = mode === "copy" ? copyDatabaseName(live, point.id) : live;
  const q = async (sql, opts) => {
    const r = await query(admin.file, sql, opts);
    if (!r.ok) throw new UserError(r.error);
    return r.rows;
  };
  const schema = async (name) =>
    (await q(`SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${str(name)}`))[0];

  // Same character set and collation as the live database, so the copy behaves the same.
  const [charset, collation] = (await schema(live)) ?? ["utf8mb4", null];
  if (mode === "copy" && (await schema(target))) {
    throw new UserError(`The database ${target} already exists (restored earlier?).`, `Drop it first if you don't need it: DROP DATABASE ${id(target)};`);
  }
  const create = `CREATE DATABASE ${id(target)} CHARACTER SET ${charset}${collation ? ` COLLATE ${collation}` : ""}`;
  // Replace: drop and recreate, so tables created after the backup don't linger.
  // Privileges granted on the database survive DROP DATABASE in MySQL and MariaDB.
  // New: the database may exist already, empty (checked before); keep it, with its grants.
  await q(
    mode === "replace"
      ? `DROP DATABASE IF EXISTS ${id(target)}; ${create}`
      : mode === "new"
        ? create.replace("CREATE DATABASE", "CREATE DATABASE IF NOT EXISTS")
        : create,
  );

  let loaded;
  try {
    loaded = await pipeDump(point.database, target, { bin, env, admin, onEvent });
  } catch (err) {
    if (mode === "copy")
      await query(admin.file, `DROP DATABASE IF EXISTS ${id(target)}`); // don't leave a half copy behind
    else err.hint = "The live database is now incomplete. Restore the safety restore point made just before (see above) with --replace.";
    throw err;
  }
  const [[tables]] = await q(`SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${str(target)} AND TABLE_TYPE = 'BASE TABLE'`);
  const ok = Number(tables) === loaded.tables;
  return {
    ok,
    database: target,
    tables: Number(tables),
    expectedTables: loaded.tables,
    bytes: loaded.bytes,
    ...(ok ? {} : { error: `Only ${tables} of ${loaded.tables} tables are in ${target}.` }),
  };
}

// restic dump | mysql, counting the tables in the dump on the way through.
function pipeDump(part, database, { bin, env, admin, onEvent }) {
  return new Promise((resolve, reject) => {
    const dump = spawn(bin, ["dump", part.snapshot, part.path], { env, stdio: ["ignore", "pipe", "pipe"] });
    const mysql = spawn(mysqlClient(), [`--defaults-extra-file=${admin.file}`, "--default-character-set=utf8mb4", database], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let dumpErr = "";
    let mysqlErr = "";
    let bytes = 0;
    let tables = 0;
    let tail = "";
    dump.stderr.on("data", (d) => (dumpErr += d));
    mysql.stderr.on("data", (d) => (mysqlErr += d));
    dump.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      // Count complete lines only; the unfinished last line waits for the next chunk.
      const text = tail + chunk.toString("latin1");
      const cut = text.lastIndexOf("\n") + 1;
      tables += (text.slice(0, cut).match(/^CREATE TABLE `/gm) ?? []).length;
      tail = text.slice(cut);
      onEvent({ type: "progress", part: "database", bytesDone: bytes, totalBytes: part.bytes ?? 0, percent: part.bytes ? bytes / part.bytes : undefined });
    });
    dump.stdout.pipe(mysql.stdin);
    mysql.stdin.on("error", () => {}); // mysql quit early: its stderr says why
    let pending = 2;
    let dumpCode;
    let mysqlCode;
    const done = () => {
      if (--pending) return;
      if (mysqlCode !== 0) return reject(new UserError(`Loading the dump failed: ${cleanError(mysqlErr) || `exit code ${mysqlCode}`}`));
      if (dumpCode !== 0) return reject(new UserError(`Reading the backup failed: ${cleanRestic(dumpErr) || `exit code ${dumpCode}`}`));
      resolve({ bytes, tables });
    };
    dump.on("error", reject);
    mysql.on("error", (e) => reject(e.code === "ENOENT" ? new UserError("The mysql client isn't installed.") : e));
    dump.on("close", (code) => ((dumpCode = code), done()));
    mysql.on("close", (code) => ((mysqlCode = code), done()));
  });
}

async function restoreFiles(point, project, { bin, env, mode, origin, target, onEvent }) {
  const folders = point.files.paths;
  if (mode === "copy") {
    const free = await statfs(await existingParent(target)).catch(() => null);
    if (free && point.files.bytes && free.bavail * free.bsize < point.files.bytes * 1.05) {
      throw new UserError(`Not enough free disk space for a copy of the files (${point.files.bytes} bytes needed).`);
    }
  }
  for (const folder of folders) {
    // Copy: keep the layout relative to the app (restores/shop-<point>/storage/app/public).
    // Replace: each backed-up folder in place. --delete is scoped to that folder,
    // never to the whole app (which would delete the code).
    const rel = relative(origin, folder);
    const dest = mode === "copy" ? join(target, rel.startsWith("..") ? folder.replace(/^\/+/, "") : rel) : destination(folder, origin, project.path);
    await mkdir(dest, { recursive: true });
    const args = ["restore", `${point.files.snapshot}:${folder}`, "--target", dest, ...(mode === "replace" ? ["--delete"] : [])];
    const r = await runJson(bin, args, {
      env,
      onMessage: (m) => {
        if (m.message_type === "status")
          onEvent({ type: "progress", part: "files", bytesDone: m.bytes_restored ?? 0, totalBytes: m.total_bytes ?? 0, percent: m.percent_done });
      },
    });
    if (r.code !== 0) throw new UserError(`Restoring ${folder} failed: ${cleanRestic(r.stderr)}`);
  }
  // restic's restore counts include folders; the backup's own figures are what people expect.
  return {
    ok: true,
    folders: folders.length,
    files: point.files.files,
    bytes: point.files.bytes,
    ...(mode === "copy" ? { path: target } : { paths: folders.map((f) => destination(f, origin, project.path)) }),
  };
}

// Where a backed-up folder goes when the app now lives in `path` (it lived in `origin`).
function destination(folder, origin, path) {
  const rel = relative(origin, folder);
  return rel.startsWith("..") ? folder : join(path, rel);
}

// True if dir holds any file other than .gitignore (which a fresh `git clone` of a
// Laravel app puts in storage/app/*).
async function hasFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory() ? await hasFiles(join(dir, e.name)) : e.name !== ".gitignore") return true;
  }
  return false;
}

async function existingParent(dir) {
  let d = dir;
  while (!existsSync(d)) d = join(d, "..");
  return d;
}

// Files in a point whose path contains `text` (case-insensitive), at most `limit`.
export async function findFiles(point, text, { bin, env, limit = 30 }) {
  const r = await run(bin, ["ls", "--json", point.files.snapshot], { env });
  if (r.code !== 0) throw new UserError(`Couldn't list the files: ${cleanRestic(r.stderr)}`);
  const needle = text.toLowerCase();
  const matches = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const node = JSON.parse(line);
    if (node.struct_type !== "node" || node.type !== "file") continue;
    if (node.path.toLowerCase().includes(needle)) matches.push({ path: node.path, size: node.size, mtime: node.mtime });
    if (matches.length >= limit) break;
  }
  return matches;
}

// Restores single files or folders (absolute paths as in the backup) into the
// copy folder, laid out like the app: restores/shop-<point>/storage/app/...
export async function restoreFilesByPath(app, pointId, filePaths, { p = paths(), log } = {}) {
  const config = await requireConfig(p);
  const project = config.projects[app];
  const bin = await ensureRestic({ p, log });
  const env = await resticEnv(config, p);
  const points = await listPoints(app, { bin, env });
  const point = !pointId || pointId === "latest" ? points[0] : points.find((pt) => pt.id === pointId);
  if (!point?.files)
    throw new UserError(pointId && pointId !== "latest" ? `No files in restore point ${pointId} of ${app}.` : `${app} has no files backed up yet.`);
  const target = copyFolder(p, app, point.id);
  // Files outside the app (it was moved since) keep their full path.
  const inside = filePaths.every((f) => !relative(project.path, f).startsWith(".."));
  const base = inside ? project.path : "/";
  const include = filePaths.flatMap((f) => ["--include", "/" + relative(base, f)]);
  const r = await run(bin, ["restore", `${point.files.snapshot}:${base}`, "--target", target, ...include], { env });
  if (r.code !== 0) throw new UserError(`Restoring failed: ${cleanRestic(r.stderr)}`);
  const restored = filePaths.map((f) => join(target, relative(base, f)));
  if (!restored.every((f) => existsSync(f)))
    throw new UserError(`Not in this restore point: ${filePaths.join(", ")}`, `Point ${point.id}. Pick another with --point.`);
  return restored;
}
