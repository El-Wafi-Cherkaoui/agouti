// Restoring restore points. Two modes:
//   copy     (default) the database goes into a new database next to the live
//            one, files into a folder under /var/lib/agouti/restores. Nothing
//            live is touched, so it's always safe to try.
//   replace  the live database and folders are replaced. A safety restore point
//            of the current state is made first, so a replace can be undone.
// No printing here: progress and results go to onEvent.
import { restoreExcludes } from "./excludes.js";
import { shield, stopAll } from "./children.js";
import { dumpFilter, loadDump, readDump } from "./dump.js";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { chmod, chown, mkdir, readdir, rename, rm, statfs } from "node:fs/promises";
import { dirname, join, parse, relative } from "node:path";
import { APP_FILE, backupApps } from "./backup.js";
import { requireConfig, writeAtomic } from "./config.js";
import { id, installClientHint, mysqlClient, optionFileContent, query, str } from "./mysql.js";
import { paths } from "./paths.js";
import { fromSnapshotPath, isWindows, relativePosix, toSnapshotPath } from "./platform.js";
import { ensureRestic, resticEnv, run, runJson } from "./restic.js";
import { includePattern, onDisk } from "./names.js";
import { acquireLock, flaggedPoints, lockFile, recordReplace } from "./state.js";
import { UserError } from "./ui.js";

// Restore points of one app, newest first:
// [{ id, at, database: { snapshot, path, bytes } | null, files: { snapshot, paths, files, bytes } | null }]
// flagged: { pointId: reason } from this server's state (see flaggedPoints).
export async function listPoints(app, { bin, env, flagged = {} }) {
  const r = await run(bin, ["snapshots", "--json", "--tag", `agouti,app=${app}`], { env });
  if (r.code !== 0) throw new UserError(`Couldn't list restore points: ${cleanRestic(r.stderr)}`);
  const points = new Map();
  for (const s of JSON.parse(r.stdout || "[]") ?? []) {
    const tag = (name) => s.tags?.find((t) => t.startsWith(`${name}=`))?.slice(name.length + 1);
    const point = tag("point");
    if (!point) continue;
    const pt = points.get(point) ?? { id: point, at: s.time, database: null, files: null, safety: s.tags.includes("kind=safety"), flagged: flagged[point] ?? null };
    if (s.time < pt.at) pt.at = s.time;
    const sum = s.summary ?? {};
    if (tag("part") === "database") pt.database = { snapshot: s.id, path: stdinPath(s.paths[0]), bytes: sum.total_bytes_processed };
    if (tag("part") === "files") pt.files = { snapshot: s.id, paths: s.paths, excludes: s.excludes ?? [], files: sum.total_files_processed, bytes: sum.total_bytes_processed };
    points.set(point, pt);
  }
  return [...points.values()].sort((a, b) => b.id.localeCompare(a.id));
}

// A database dump is saved from standard input as <db>.sql. restic lists it as
// /shop.sql (Linux) or C:\shop.sql (Windows), but inside the snapshot it's /shop.sql
// on both, and that's what `restic dump` needs.
export const stdinPath = (listed) => `/${String(listed).split(/[\\/]/).pop()}`;

// What "latest" means: the newest real backup that has every part asked for. Not a
// point saved before a restore (it may hold the very damage being undone), and not
// one whose database or files failed.
// Nor one flagged as holding suspect data (it shrank sharply, or was taken during an
// unfinished replace).
export function newestBackup(points, parts = ["database", "files"]) {
  return points.find((pt) => !pt.safety && !pt.flagged && parts.every((part) => pt[part]));
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
    // The newest point that could actually be restored: a database, and the files if
    // the app has any. A newer, incomplete one shouldn't be called the last backup.
    const needFiles = (description.files ?? []).length > 0;
    const byPoint = new Map();
    for (const snap of app.snapshots) {
      const tag = (name) => snap.tags?.find((t) => t.startsWith(`${name}=`))?.slice(name.length + 1);
      const pt = byPoint.get(tag("point")) ?? { at: snap.time, parts: new Set() };
      pt.parts.add(tag("part"));
      if (snap.time > pt.at) pt.at = snap.time;
      byPoint.set(tag("point"), pt);
    }
    const completeAt = [...byPoint.values()]
      .filter((pt) => pt.parts.has("database") && (!needFiles || pt.parts.has("files")))
      .map((pt) => pt.at)
      .sort()
      .at(-1);
    found.push({ name: app.name, host: app.host, at: app.at, completeAt, points: app.points.size, description });
  }
  return found.sort((a, b) => b.at.localeCompare(a.at));
}

function guessDescription(app) {
  const latest = (part) => app.snapshots.filter((s) => s.tags.includes(`part=${part}`)).sort((a, b) => b.time.localeCompare(a.time))[0];
  const db = latest("database");
  const folders = latest("files")?.paths ?? [];
  const sep = isWindows() ? "\\" : "/";
  // The app's folder: above storage/ (Laravel), else the folders' common parent.
  const common = folders.length ? folders.reduce((a, b) => commonDir(a, b, sep)) : "";
  const at = common.indexOf(`${sep}storage`);
  const path = at >= 0 ? common.slice(0, at) : common;
  return {
    app: app.name,
    path,
    database: { engine: "mysql", name: db ? stdinPath(db.paths[0]).slice(1).replace(/\.sql$/, "") : app.name },
    files: folders.map((f) => relativePosix(path, f)),
    guessed: true,
  };
}

function commonDir(a, b, sep = "/") {
  const x = a.split(sep);
  const y = b.split(sep);
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return x.slice(0, i).join(sep) || sep;
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

// Where a replace tries a backup out first.
export function checkDatabaseName(database) {
  const suffix = "_agouti_check";
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
    if (test.missing) throw new UserError("The mysql client isn't installed.", installClientHint());
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
  const state = { safety: null, touchingLive: false, checking: null };
  const unguard = guardInterrupts(state, {
    app,
    onEvent,
    cleanup: () => {
      if (admin && state.checking) {
        spawnSync(mysqlClient(), [`--defaults-extra-file=${admin.file}`, "-e", `DROP DATABASE IF EXISTS ${id(state.checking)}`], { stdio: "ignore", timeout: 10000 });
      }
      if (admin) rmSync(admin.file, { force: true });
      rmSync(lockFile(p), { force: true });
    },
  });
  try {
    const bin = await ensureRestic({ p, log });
    const env = await resticEnv(config, p);
    const points = await listPoints(app, { bin, env, flagged: await flaggedPoints(app, p) });
    if (!points.length) throw new UserError(`${app} has no restore points yet.`, `Make one: sudo agouti backup ${app}`);
    const latest = !opts.point || opts.point === "latest";
    const point = latest ? newestBackup(points, parts) : points.find((pt) => pt.id === opts.point);
    if (!point && latest) throw new UserError(`No backup of ${app} has ${parts.join(" and ")} and looks normal: each one is incomplete or flagged.`, `See them: sudo agouti restore ${app} --list`);
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
        throw new UserError(`${folder} already exists (restored earlier?).`, `Delete it first if you don't need it: ${isWindows() ? `rmdir /S /Q "${folder}"` : `rm -r ${folder}`}`);
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

    const result = { app, point: point.id, at: point.at, mode, ok: true, framework: project.framework };
    // Replacing drops the live database, so first prove this backup loads. Once it's
    // dropped, a damaged backup would leave nothing, and undo may share the same damage.
    if (mode === "replace" && parts.includes("database")) {
      onEvent({ type: "check-start", app });
      state.checking = checkDatabaseName(project.database.name);
      try {
        await tryLoading(point, project, { bin, env, admin, name: state.checking, onEvent });
      } catch (err) {
        onEvent({ type: "check-failed", app });
        throw new UserError(`This backup can't be restored, so nothing was replaced. ${err.message}`, err.hint);
      } finally {
        state.checking = null;
      }
      onEvent({ type: "check-done", app });
    }
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
      // The safety point re-uses data already in the repository, damage included. It's
      // the only way back once the live database is gone, so make sure it can be read.
      if (parts.includes("database")) {
        const saved = (await listPoints(app, { bin, env })).find((pt) => pt.id === safety.point);
        await readDump(saved.database, { bin, env }).catch((err) => {
          throw new UserError(
            `The current database was saved, but the saved copy can't be read back, so nothing was replaced. Undo wouldn't work. ${err.message}`,
            "Your live data is as it was. The backup storage may be damaged: check it, and keep a separate copy of the database before trying again.",
          );
        });
      }
    }

    state.touchingLive = mode !== "copy";
    if (mode === "replace") {
      await recordReplace(app, { at: new Date().toISOString(), point: point.id, pointAt: point.at, safety: state.safety, parts }, p);
    }
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
    if (mode === "replace" && result.ok) await recordReplace(app, null, p);
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

// Loads the backup into a throwaway database and drops it again: nothing live is
// touched. It proves the backup can be read and that this server accepts the dump.
async function tryLoading(point, project, { bin, env, admin, name, onEvent }) {
  const q = async (sql) => {
    const r = await query(admin.file, sql);
    if (!r.ok) throw new UserError(r.error);
    return r.rows;
  };
  // Keep it out of the binary log, and so off any replica, if this user may.
  const noLog = (await query(admin.file, "SET SESSION sql_log_bin = 0")).ok ? "SET SESSION sql_log_bin = 0;" : "";
  const [[charset, collation] = ["utf8mb4", null]] = await q(`SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${str(project.database.name)}`);
  await q(`${noLog} DROP DATABASE IF EXISTS ${id(name)}; CREATE DATABASE ${id(name)} CHARACTER SET ${charset}${collation ? ` COLLATE ${collation}` : ""}`);
  try {
    const loaded = await loadDump(point.database, name, { bin, env, optionFile: admin.file, onEvent, prelude: noLog, filter: dumpFilter({ skipEvents: true }) });
    const [[tables]] = await q(`SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${str(name)} AND TABLE_TYPE = 'BASE TABLE'`);
    if (Number(tables) !== loaded.tables) throw new UserError(`Only ${tables} of ${loaded.tables} tables could be loaded.`);
  } finally {
    await query(admin.file, `${noLog} DROP DATABASE IF EXISTS ${id(name)}`);
  }
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
    loaded = await loadDump(point.database, target, { bin, env, optionFile: admin.file, onEvent });
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

async function restoreFiles(point, project, { bin, env, mode, origin, target, onEvent }) {
  const folders = point.files.paths;
  if (mode === "copy") {
    const free = await statfs(await existingParent(target)).catch(() => null);
    if (free && point.files.bytes && free.bavail * free.bsize < point.files.bytes * 1.05) {
      throw new UserError(`Not enough free disk space for a copy of the files (${point.files.bytes} bytes needed).`);
    }
  }
  // Every folder is attempted: one with damaged data must not cost the others.
  const damaged = []; // shown relative to the app, e.g. storage/app/private/x.pdf
  const failed = [];
  for (const folder of folders) {
    // Copy: keep the layout relative to the app (restores/shop-<point>/storage/app/public).
    // Replace: each backed-up folder in place. --delete is scoped to that folder,
    // never to the whole app (which would delete the code), and skips what this
    // backup left out on purpose (it isn't in the snapshot, but must not be deleted).
    const rel = relative(origin, folder);
    const dest = mode === "copy" ? join(target, rel.startsWith("..") ? outsidePath(folder) : rel) : destination(folder, origin, project.path);
    try {
      // New server: the folders mkdir creates would belong to root, and the app
      // couldn't write into them. Afterwards they get the owner the backup recorded.
      const created = mode === "new" ? await missingDirs(dest, project.path) : [];
      await mkdir(dest, { recursive: true });
      // --sparse: runs of zeros stay holes, so a sparse file (a VM image, a database
      // file) takes the space it did, not its full size. Contents are identical.
      const args = ["restore", `${point.files.snapshot}:${toSnapshotPath(folder)}`, "--target", dest, "--sparse", ...(mode === "replace" ? ["--delete", ...restoreExcludes(point.files.excludes, folder).flatMap((x) => ["--exclude", x])] : [])];
      const r = await runJson(bin, args, {
        env,
        onMessage: (m) => {
          if (m.message_type === "status")
            onEvent({ type: "progress", part: "files", bytesDone: m.bytes_restored ?? 0, totalBytes: m.total_bytes ?? 0, percent: m.percent_done });
        },
      });
      if (created.length) await applyRecordedOwners(created, { bin, env, snapshot: point.files.snapshot, toBackup: (d) => join(origin, relative(project.path, d)) });
      const bad = await markDamaged(dest, r.errors);
      damaged.push(...bad.map((item) => join(rel.startsWith("..") ? folder : rel, item)));
      if (r.code !== 0 && !bad.length) failed.push(`${folder}: ${cleanRestic(r.stderr)}`);
    } catch (err) {
      failed.push(`${folder}: ${err.message}`);
    }
  }
  if (damaged.length || failed.length) {
    const n = damaged.length;
    const listed = damaged.slice(0, 10).join(", ") + (n > 10 ? `, and ${n - 10} more` : "");
    const parts = [
      n && `${n} ${n === 1 ? "file" : "files"} couldn't be restored because the backup data is damaged: ${listed}. Any partial copy was renamed to *.damaged, so it can't pass for a good one`,
      failed.length && `Not restored: ${failed.join("; ")}`,
    ].filter(Boolean);
    return {
      ok: false,
      error: `${parts.join(". ")}. Everything else was restored.`,
      hint: n ? "Restore those files from an older restore point (Restore → A single file), and check the backup storage." : undefined,
      damaged,
      folders: folders.length,
    };
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

// Where a folder that was outside the app goes inside a copy: its full path, as
// folders (restores/shop-<point>/srv/old/uploads, or .../C/old/uploads on Windows).
const outsidePath = (folder) => toSnapshotPath(folder).replace(/^\/+/, "");

// The folders from `dir` up to (not including) `root` that don't exist yet, deepest first.
async function missingDirs(dir, root) {
  const out = [];
  for (let d = dir; d !== root && d.startsWith(root) && !existsSync(d); d = dirname(d)) out.push(d);
  return out;
}

// Gives each folder the owner and permissions it had in the backup. Folders the
// backup doesn't know (above what was backed up) are left alone.
async function applyRecordedOwners(dirs, { bin, env, snapshot, toBackup }) {
  // Windows: restic keeps no owners there; new folders inherit their parent's permissions.
  if (isWindows()) return;
  for (const dir of dirs) {
    const path = toBackup(dir);
    const r = await run(bin, ["ls", "--json", snapshot, path], { env });
    if (r.code !== 0) continue;
    const node = r.stdout
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((n) => n?.type === "dir" && n.path === path);
    if (!node) continue;
    await chown(dir, node.uid, node.gid).catch(() => {}); // needs root; tests run without
    await chmod(dir, unixMode(node.mode)).catch(() => {});
  }
}

// restic stores Go's os.FileMode: permission bits plus setuid/setgid/sticky as high bits.
export function unixMode(goMode) {
  return (goMode & 0o777) | (goMode & (1 << 23) ? 0o4000 : 0) | (goMode & (1 << 22) ? 0o2000 : 0) | (goMode & (1 << 20) ? 0o1000 : 0);
}

// restic leaves a file whose data couldn't be read at full size with wrong contents.
// Renamed, it can't pass for a good copy. Returns the damaged items, relative to dest.
async function markDamaged(dest, errors) {
  const items = [...new Set(errors.filter((m) => m.during === "restore" && m.item).map((m) => m.item.replace(/^[\\/]+/, "")))];
  for (const item of items) await rename(join(dest, item), join(dest, `${item}.damaged`)).catch(() => {}); // restic may not have written it at all
  return items;
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
    // Shown and restored as a path on this system (C:\inetpub\shop\... on Windows).
    if (node.path.toLowerCase().includes(needle)) matches.push({ path: fromSnapshotPath(node.path), size: node.size, mtime: node.mtime });
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
  const points = await listPoints(app, { bin, env, flagged: await flaggedPoints(app, p) });
  const point = !pointId || pointId === "latest" ? newestBackup(points, ["files"]) : points.find((pt) => pt.id === pointId);
  if (!point?.files)
    throw new UserError(pointId && pointId !== "latest" ? `No files in restore point ${pointId} of ${app}.` : `${app} has no files backed up yet.`);
  const target = copyFolder(p, app, point.id);
  // Files outside the app (it was moved since) keep their full path.
  const inside = filePaths.every((f) => !relative(project.path, f).startsWith(".."));
  // Outside: from the top of the file's drive (Windows) or of the system. On
  // Windows the snapshot's own top folder (/C) can't be restored as such.
  const base = inside ? project.path : parse(filePaths[0]).root;
  const include = filePaths.flatMap((f) => ["--include", includePattern("/" + relative(base, f))]);
  // An earlier copy of the same file (a full copy of this point, a previous single
  // file) must not pass for this restore: if restic didn't write it, it isn't there.
  for (const f of filePaths) await rm(join(target, relative(base, f)), { recursive: true, force: true });
  const r = await runJson(bin, ["restore", `${point.files.snapshot}:${toSnapshotPath(base)}`, "--target", target, "--sparse", ...include], { env });
  const bad = await markDamaged(target, r.errors);
  if (bad.length) {
    throw new UserError(
      `The backup data of ${bad.join(", ")} is damaged in restore point ${point.id}, so it couldn't be restored (any partial copy is in ${target} as *.damaged).`,
      "Try an older restore point, and check the backup storage.",
    );
  }
  if (r.code !== 0) throw new UserError(`Restoring failed: ${cleanRestic(r.stderr)}`);
  // Real paths on disk (a Buffer when the name isn't valid UTF-8; see names.js).
  const restored = await Promise.all(filePaths.map((f) => onDisk(join(target, relative(base, f)))));
  if (!restored.every(Boolean))
    throw new UserError(`Not in this restore point: ${filePaths.join(", ")}`, `Point ${point.id}. Pick another with --point.`);
  return restored;
}
