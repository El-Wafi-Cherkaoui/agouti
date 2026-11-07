// Restore tests: proof that backups can actually be restored.
//
// For each app, the latest restore point is restored for real:
//   database  loaded into a throwaway database (agouti_verify_<app>), tables and
//             rows counted, then dropped. Done as `agouti_verify`, a MySQL user
//             that can only create and drop databases named agouti_verify_*:
//             it can't read or change any real database.
//   files     a random sample is restored and checked: size, and the checksum
//             against the live file when that file hasn't changed since.
// Then the results are compared with the previous test, to catch backups that
// "work" but hold the wrong thing (a table emptied, most files gone).
// No printing here: progress and results go to onEvent.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { requireConfig, saveConfig, writeAtomic } from "./config.js";
import { dumpFilter, loadDump } from "./dump.js";
import { generatePassword, id, optionFileContent, query, str } from "./mysql.js";
import { paths } from "./paths.js";
import { adminConnection, listPoints } from "./restore.js";
import { EXIT, clearStaleLocks, ensureRestic, lockedMessage, resticEnv, run } from "./restic.js";
import { acquireLock, loadState, recordDataCheck, recordVerify } from "./state.js";
import { UserError } from "./ui.js";

export const VERIFY_USER = "agouti_verify";
export const VERIFY_EVERY_DAYS = 7;
const SAMPLE_FILES = 20;

export const throwawayName = (app) => `agouti_verify_${app.replace(/-/g, "_")}`.slice(0, 64);

// Creates the agouti_verify user through an admin connection (used once, not
// stored) and saves its credentials. server: { host, port } or { socket }.
export async function setupVerifier(server, { admin = {}, p = paths() } = {}) {
  const conn = await adminConnection({ database: server }, { ...admin, p });
  const local = !admin.host && (server.socket || ["localhost", "127.0.0.1", "::1"].includes(server.host));
  const who = `${str(VERIFY_USER)}@${str(local ? "localhost" : "%")}`;
  const password = generatePassword();
  try {
    const r = await query(
      conn.file,
      `CREATE USER IF NOT EXISTS ${who} IDENTIFIED BY ${str(password)}; ALTER USER ${who} IDENTIFIED BY ${str(password)}; ` +
        // Only databases named agouti_verify_*. In GRANT, _ is a wildcard: escape it.
        "GRANT ALL PRIVILEGES ON `agouti\\_verify\\_%`.* TO " +
        who,
    );
    if (!r.ok) throw new UserError(`Couldn't create the ${VERIFY_USER} user: ${r.error}`);
    // Lets it keep its throwaway databases out of the binary log (and off replicas).
    // MySQL 8.0.14+; elsewhere binary logging is usually off anyway.
    await query(conn.file, `GRANT SESSION_VARIABLES_ADMIN ON *.* TO ${who}`);
  } finally {
    await conn.cleanup();
  }

  // Connect the way the admin did: over the network to the server given, or through
  // the local socket (which is what a 'localhost' MySQL account matches).
  const target = admin.host ? { host: admin.host, port: admin.port } : server.socket ? { socket: server.socket } : { host: "localhost", port: 3306 };
  const file = join(p.configDir, "verify.cnf");
  await writeAtomic(file, optionFileContent({ username: VERIFY_USER, password, ...target }), 0o600);
  const test = await query(file, "SELECT 1");
  if (!test.ok) throw new UserError(`The ${VERIFY_USER} user was created but can't connect: ${test.error}`);

  const config = await requireConfig(p);
  config.verify = { user: VERIFY_USER, credentials: file, server: target.socket ? { socket: target.socket } : { host: target.host, port: target.port } };
  await saveConfig(config, p);
  return config.verify;
}

// Is this app's database on the server the verify user lives on? A local server
// may be reached by socket or by 127.0.0.1:port; a socket says nothing about the port.
export function sameServer(server, db) {
  const local = (x) => Boolean(x.socket) || ["localhost", "127.0.0.1", "::1"].includes(x.host);
  if (local(server) !== local(db)) return false;
  if (local(server) && (server.socket || db.socket || server.host === "localhost" || db.host === "localhost")) return true;
  return server.host === db.host && (server.port ?? 3306) === (db.port ?? 3306);
}

// Due when an app has never been tested, or its last test is a week old.
export function verifyDue(config, state, now = Date.now()) {
  if (!config.verify) return false;
  return Object.keys(config.projects ?? {}).some((name) => {
    const last = state.projects?.[name]?.lastVerify;
    return !last || now - Date.parse(last.at) > (VERIFY_EVERY_DAYS - 0.5) * 86400000;
  });
}

// A plain `restic check` only checks the structure: a damaged data file passes it,
// and restoring one point reads only that point's data (and only a sample of its
// files). So each test also reads one part of all the data, a different part each
// time: every byte is read back once every DATA_PARTS tests (about monthly with
// weekly tests), at a quarter of the repository's size in downloads per test.
export const DATA_PARTS = 4;

// Tests the named apps (all when empty). Returns { apps: [result], repository: { ok, error } }.
export async function verifyApps(names = [], { p = paths(), onEvent = () => {}, log } = {}) {
  const config = await requireConfig(p);
  if (!config.verify) {
    throw new UserError("Restore tests aren't set up yet.", 'Run `sudo agouti verify --setup`, or choose "Test a restore" in `sudo agouti`.');
  }
  const all = Object.keys(config.projects ?? {});
  const unknown = names.filter((n) => !config.projects[n]);
  if (unknown.length) throw new UserError(`Unknown app: ${unknown.join(", ")}`, `Apps: ${all.join(", ")}`);
  const selected = names.length ? [...new Set(names)] : all;
  if (!selected.length) throw new UserError("There are no apps to test yet.");

  const release = await acquireLock(p);
  try {
    const bin = await ensureRestic({ p, log });
    const env = await resticEnv(config, p);

    // The repository's structure (indexes, snapshots, packs): one check for all apps.
    onEvent({ type: "repository-start" });
    await clearStaleLocks(bin, env); // check refuses while an interrupted backup's lock is there
    const part = (((await loadState(p)).dataCheck?.next ?? 1) - 1) % DATA_PARTS + 1;
    const check = await run(bin, ["check", `--read-data-subset=${part}/${DATA_PARTS}`], { env });
    const read = { dataPart: part, dataParts: DATA_PARTS };
    const repository =
      check.code === 0
        ? { ok: true, ...read }
        : check.code === EXIT.LOCKED
          ? { ok: false, locked: true, error: lockedMessage("The repository check couldn't run") }
          : { ok: false, ...read, error: checkError(check.stderr || check.stdout) };
    if (!repository.locked) await recordDataCheck((part % DATA_PARTS) + 1, p);
    onEvent({ type: "repository-done", result: repository });

    const state = await loadState(p);
    const apps = [];
    for (const name of selected) {
      const result = await verifyApp(name, config.projects[name], { bin, env, config, p, prev: state.projects?.[name]?.lastVerify, onEvent, repository });
      await recordVerify(name, result, p);
      apps.push(result);
    }
    return { apps, repository };
  } finally {
    await release();
  }
}

// restic ends with "Fatal: repository contains errors"; the line naming the damaged
// file comes before it.
function checkError(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  const specific = lines.find((l) => /pack [0-9a-f]{8}|ciphertext verification failed|not referenced|error for tree|is damaged/i.test(l));
  const last = lines.at(-1)?.replace(/^Fatal:\s*/, "") ?? "";
  return specific && specific !== lines.at(-1) ? `${last} (${specific.trim().slice(0, 200)})` : last;
}

async function verifyApp(name, project, { bin, env, config, p, prev, onEvent, repository = { ok: true } }) {
  const started = new Date();
  const points = await listPoints(name, { bin, env });
  const complete = (pt) => pt.database && (!project.files?.length || pt.files);
  const point = points.find((pt) => complete(pt) && !pt.safety) ?? points[0];
  if (!point) {
    const result = { app: name, at: started.toISOString(), status: "failed", problems: ["There's no restore point to test yet."] };
    onEvent({ type: "app-done", result });
    return result;
  }
  onEvent({ type: "app-start", app: name, point: point.id, pointAt: point.at });

  const result = { app: name, at: started.toISOString(), point: point.id, pointAt: point.at, problems: [], notes: [] };
  result.database = await part("database", onEvent, () => verifyDatabase(name, project, point, { bin, env, config, onEvent }));
  result.files = await part("files", onEvent, () => verifyFiles(name, point, { bin, env, p }));
  compare(result, prev);
  // Restoring one point proves little if the repository's structure wasn't checked:
  // never "verified" then.
  if (!repository.ok) result.problems.push(repository.locked ? "The repository check couldn't run (the storage was in use)." : `The repository check found errors: ${repository.error}`);

  const failed = !result.database.ok || !result.files.ok || (!repository.ok && !repository.locked);
  result.status = failed ? "failed" : result.problems.length ? "warning" : "verified";
  result.seconds = Math.round((Date.now() - started) / 1000);
  onEvent({ type: "app-done", result });
  return result;
}

async function part(name, onEvent, fn) {
  const started = Date.now();
  onEvent({ type: "part-start", part: name });
  let r;
  try {
    r = await fn();
  } catch (err) {
    r = { ok: false, error: err.message, hint: err.hint };
  }
  r.seconds = Math.round((Date.now() - started) / 100) / 10;
  onEvent({ type: "part-done", part: name, result: r });
  return r;
}

async function verifyDatabase(app, project, point, { bin, env, config, onEvent }) {
  if (!point.database) return { ok: false, error: "This restore point has no database (that part of the backup failed)." };
  if (!sameServer(config.verify.server, project.database)) {
    return { ok: true, skipped: true, note: `Not tested: the database is on another server than the ${VERIFY_USER} user.` };
  }
  const file = config.verify.credentials;
  const db = throwawayName(app);
  const sql = async (text) => {
    const r = await query(file, text);
    if (!r.ok) throw new UserError(r.error);
    return r.rows;
  };

  // With binary logging on, MySQL refuses triggers and stored functions to users
  // without SUPER; they're then checked in the dump only. If allowed, keep the
  // throwaway database out of the binary log (and so off any replica).
  const [[logBin, trust] = []] = await sql("SELECT @@log_bin, @@log_bin_trust_function_creators");
  const skipBinlogged = logBin === "1" && trust !== "1";
  const noLog = (await query(file, "SET SESSION sql_log_bin = 0")).ok ? "SET SESSION sql_log_bin = 0;" : "";

  await sql(`${noLog} DROP DATABASE IF EXISTS ${id(db)}; CREATE DATABASE ${id(db)} CHARACTER SET utf8mb4`);
  try {
    const loaded = await loadDump(point.database, db, {
      bin,
      env,
      optionFile: file,
      onEvent,
      prelude: noLog,
      filter: dumpFilter({ restricted: true, skipBinlogged }),
    });
    const tables = (await sql(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${str(db)} AND TABLE_TYPE = 'BASE TABLE'`)).map(
      ([t]) => t,
    );
    // Exact row counts (information_schema only estimates them for InnoDB).
    const rows = {};
    for (let i = 0; i < tables.length; i += 100) {
      const chunk = tables.slice(i, i + 100);
      const counts = await sql(chunk.map((t) => `SELECT ${str(t)}, COUNT(*) FROM ${id(db)}.${id(t)}`).join(" UNION ALL "));
      for (const [t, n] of counts) rows[t] = Number(n);
    }
    const total = Object.values(rows).reduce((a, b) => a + b, 0);
    const r = {
      ok: tables.length === loaded.tables,
      tables: tables.length,
      rows: total,
      tableRows: rows,
      views: loaded.views,
      procedures: loaded.procedures,
      triggers: loaded.triggers,
      functions: loaded.functions,
      notLoaded: loaded.skipped, // triggers and functions checked in the dump only
      bytes: loaded.bytes,
    };
    if (!r.ok) r.error = `Only ${tables.length} of the ${loaded.tables} tables in the dump could be restored.`;
    return r;
  } catch (err) {
    if (/\b1419\b|SUPER privilege/.test(err.message)) {
      err.hint = "Binary logging blocks this for users without SUPER. Run as root: SET GLOBAL log_bin_trust_function_creators = 1; or report it as a bug.";
    }
    throw err;
  } finally {
    await query(file, `${noLog} DROP DATABASE IF EXISTS ${id(db)}`);
  }
}

async function verifyFiles(app, point, { bin, env, p }) {
  if (!point.files) return { ok: true, skipped: true };
  const ls = await run(bin, ["ls", "--json", point.files.snapshot], { env });
  if (ls.code !== 0) return { ok: false, error: `Couldn't list the files: ${lastLine(ls.stderr)}` };
  const files = ls.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((n) => n.struct_type === "node" && n.type === "file");
  if (!files.length) return { ok: true, total: 0, sampled: 0, compared: 0 };

  const sample = shuffle(files).slice(0, SAMPLE_FILES);
  const tmp = join(p.dataDir, "verify-tmp", app);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  try {
    const r = await run(bin, ["restore", point.files.snapshot, "--target", tmp, ...sample.flatMap((n) => ["--include", n.path])], { env });
    if (r.code !== 0) return { ok: false, error: `Restoring a sample of files failed: ${lastLine(r.stderr)}` };
    let compared = 0;
    const bad = [];
    for (const n of sample) {
      const restored = join(tmp, n.path);
      const s = await stat(restored).catch(() => null);
      if (!s || s.size !== n.size) {
        bad.push(`${n.path}: ${s ? `${s.size} bytes, expected ${n.size}` : "missing after restore"}`);
        continue;
      }
      // Unchanged since the backup (same size and modification time)? Then the
      // restored copy must be byte-for-byte the live one.
      const live = await stat(n.path).catch(() => null);
      if (live && live.size === n.size && Math.abs(live.mtimeMs - preciseMs(n.mtime)) < 1) {
        compared++;
        if ((await sha256(restored)) !== (await sha256(n.path))) bad.push(`${n.path}: content differs from the live file, which hasn't changed`);
      }
    }
    return {
      ok: bad.length === 0,
      total: files.length,
      sampled: sample.length,
      compared,
      ...(bad.length ? { error: `${bad.length} of ${sample.length} sampled files are wrong: ${bad.slice(0, 3).join("; ")}` } : {}),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Backups that restore fine but hold the wrong thing: compared with the last test.
function compare(result, prev) {
  if (!prev || prev.status === "failed") return;
  const db = result.database;
  const before = prev.database?.tableRows;
  if (db?.ok && !db.skipped && before) {
    for (const [table, n] of Object.entries(before)) {
      const now = db.tableRows[table];
      if (now === undefined) result.problems.push(`Table ${table} is gone (${fmt(n)} rows in the last test).`);
      else if (n >= 100 && now < n / 2) result.problems.push(`${table}: ${fmt(n)} rows in the last test, ${fmt(now)} now.`);
    }
  }
  const files = result.files;
  if (files?.ok && !files.skipped && prev.files?.total >= 20 && files.total < prev.files.total / 2) {
    result.problems.push(`Files: ${fmt(prev.files.total)} in the last test, ${fmt(files.total)} now.`);
  }
}

// restic keeps nanoseconds; Date.parse stops at milliseconds. Keep the rest.
export function preciseMs(iso) {
  const frac = String(iso).match(/\.(\d+)/)?.[1] ?? "";
  return Date.parse(iso) + Number(`0.${frac.slice(3) || "0"}`);
}

const fmt = (n) => Number(n).toLocaleString("en-US");

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

function lastLine(text = "") {
  const l = text.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(l).message ?? l;
  } catch {
    return l.replace(/^Fatal: /, "");
  }
}
