// Backing up apps. Each run makes one restore point per app: a database snapshot
// and a files snapshot in restic, both tagged with the same point=<id>, so the
// database and the files can always be restored as a matching pair.
// No printing here: progress and results go to onEvent, and both `agouti backup`
// and the interactive app render them.
import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { requireConfig } from "./config.js";
import { storageReachable } from "./repository.js";
import { excludePatterns } from "./excludes.js";
import { dumpCommand } from "./mysql.js";
import { paths } from "./paths.js";
import { EXIT, ensureRestic, resticEnv, run, runJson } from "./restic.js";
import { acquireLock, baselineOf, loadState, recordBackup } from "./state.js";
import { formatBytes } from "./detect.js";
import { UserError } from "./ui.js";

// Backs up the named apps (all when empty). Returns one result per app.
// lock: false when the caller already holds the backup lock (restore's safety backup).
// tags: extra restic tags, e.g. kind=safety for the point made before a restore.
export async function backupApps(names = [], { p = paths(), onEvent = () => {}, log, lock = true, tags = [] } = {}) {
  const config = await requireConfig(p);
  const all = Object.keys(config.projects ?? {});
  if (!all.length) throw new UserError("There are no apps to back up yet.", "Add one with `sudo agouti` or `sudo agouti add <dir>`.");
  const unknown = names.filter((n) => !config.projects[n]);
  if (unknown.length) throw new UserError(`Unknown app: ${unknown.join(", ")}`, `Apps: ${all.join(", ")}`);
  const selected = names.length ? [...new Set(names)] : all;

  // Ctrl-C reaches restic too (same terminal), which stops and removes its lock.
  // Catch it here, so the backup ends with what was and wasn't saved, and the
  // attempt is recorded. A second Ctrl-C quits at once.
  let stopped = false;
  const onInt = () => {
    if (stopped) process.exit(130);
    stopped = true;
  };
  const release = lock ? await acquireLock(p) : async () => {};
  try {
    // Seconds, not half an hour of restic retrying, when the drive is unplugged.
    const reach = await storageReachable(config, { p, log });
    if (!reach.ok) throw new UserError(reach.message, `${reach.hint} Nothing was backed up: check it, then run the backup again.`);
    const bin = await ensureRestic({ p, log });
    const env = await resticEnv(config, p);
    const results = [];
    const safety = tags.includes("kind=safety");
    if (!safety) process.on("SIGINT", onInt);
    const state = await loadState(p);
    for (const name of selected) {
      const s = state.projects[name];
      const baseline = safety ? undefined : (s?.baseline ?? baselineOf(s?.lastSuccess));
      const replacing = safety ? undefined : s?.replacing;
      const result = await backupApp(name, config.projects[name], { bin, env, onEvent, extraTags: tags, baseline, replacing, isStopped: () => stopped });
      // A point saved before a restore isn't a backup: counted as one, the status would
      // say "backed up 5 min ago" while real backups had stopped days ago.
      if (!safety) await recordBackup(name, result, p);
      results.push(result);
      if (stopped) break; // the other apps aren't started
    }
    return results;
  } finally {
    process.off("SIGINT", onInt);
    await release();
  }
}

export const APP_FILE = "agouti-app.json";

export function appDescription(name, project) {
  const db = project.database;
  return {
    app: name,
    path: project.path,
    ...(project.framework ? { framework: project.framework } : {}),
    database: { engine: db.engine ?? "mysql", name: db.name, ...(db.socket ? { socket: db.socket } : { host: db.host, port: db.port }), user: db.user },
    files: project.files ?? [],
    ...(project.exclude?.length ? { exclude: project.exclude } : {}),
  };
}

export function pointId(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

async function backupApp(name, project, { bin, env, onEvent, extraTags = [], baseline, replacing, isStopped = () => false }) {
  const started = new Date();
  const point = pointId(started);
  const tags = ["agouti", `app=${name}`, `point=${point}`, ...extraTags];
  const common = ["backup", "--host", hostname()];
  onEvent({ type: "app-start", app: name, point });

  // Database: restic runs mysqldump itself and stores its output, so the dump is
  // never written to disk. If mysqldump fails, restic discards the snapshot.
  const database = await part(name, "database", onEvent, async (progress) => {
    const db = project.database;
    const argv = await dumpCommand(db.credentials, db.name);
    const r = await runJson(
      bin,
      [...common, "--tag", [...tags, "part=database"].join(","), "--stdin-from-command", "--stdin-filename", `${db.name}.sql`, "--", ...argv],
      {
        env,
        onMessage: progress,
      },
    );
    if (r.code !== EXIT.OK || !r.summary) {
      const error = describeFailure(r, basename(argv[0]));
      return { ok: false, error, hint: databaseHint(error, project) };
    }
    return { ok: true, snapshot: r.summary.snapshot_id, bytes: r.summary.total_bytes_processed, added: r.summary.data_added };
  }, isStopped);

  // Files: only what changed since last time is uploaded (restic deduplicates).
  const files = await part(name, "files", onEvent, async (progress) => {
    const dirs = (project.files ?? []).map((f) => join(project.path, f));
    if (!dirs.length) return { ok: true, skipped: true };
    const missing = [];
    for (const d of dirs) if (!(await stat(d).catch(() => null))?.isDirectory()) missing.push(d);
    if (missing.length) return { ok: false, error: `Folder missing: ${missing.join(", ")}. Was it moved or deleted?` };

    const { patterns, ignored } = excludePatterns(project);
    const r = await runJson(bin, [...common, "--tag", [...tags, "part=files"].join(","), ...patterns.flatMap((x) => ["--exclude", x]), ...dirs], {
      env,
      onMessage: progress,
    });
    // Exit 3: snapshot saved, but some files couldn't be read (permissions, vanished mid-backup).
    if ((r.code !== EXIT.OK && r.code !== 3) || !r.summary) return { ok: false, error: describeFailure(r, "restic") };
    if (patterns.length && r.summary.total_files_processed === 0) {
      return { ok: false, error: "The exclude rules left out every file, so no files were saved.", hint: `Check exclude for ${name} in agouti.yml: ${patterns.join(", ")}` };
    }
    // A file deleted while the backup ran isn't missing from anything; one that can't be read is.
    const unreadable = r.errors.filter((m) => !/no such file or directory/i.test(m.error?.message ?? ""));
    const warnings = [
      ...(unreadable.length ? [unreadableText(unreadable)] : []),
      ...ignored.map((x) => `Exclude rule ignored, so these files were backed up: ${x}.`),
    ];
    return {
      ok: true,
      snapshot: r.summary.snapshot_id,
      files: r.summary.total_files_processed,
      bytes: r.summary.total_bytes_processed,
      added: r.summary.data_added,
      newFiles: r.summary.files_new,
      changed: r.summary.files_changed,
      ...(unreadable.length ? { unreadable: unreadableText(unreadable) } : {}),
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  }, isStopped);

  // What a new server needs to restore this app after this one is lost: where it
  // lived and what to back up. Never credentials.
  let described = { ok: true };
  if ((database.ok || files.ok) && !isStopped()) {
    const r = await run(bin, [...common, "--tag", [...tags, "part=app"].join(","), "--stdin", "--stdin-filename", APP_FILE], {
      env,
      stdin: JSON.stringify(appDescription(name, project), null, 2) + "\n",
    });
    if (r.code !== 0) described = { ok: false, error: describeFailure({ ...r, messages: [] }, "restic") };
  }

  const result = {
    app: name,
    point,
    at: started.toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    ok: database.ok && files.ok,
    database,
    files,
    ...(described.ok ? {} : { warning: `The app's description wasn't saved (${described.error}); a new server couldn't find this app.` }),
  };
  if (isStopped()) result.stopped = true;
  const shrunk = shrinkage(baseline, result);
  if (shrunk) result.shrunk = shrunk;
  if (replacing) result.halfRestored = `${replaceText(replacing)}, so this backup may hold half-restored data.`;
  onEvent({ type: "app-done", app: name, result });
  return result;
}

// "A replace from 2026-11-05 10:32 UTC didn't finish (started 2026-11-07 12:30 UTC)"
export function replaceText(r) {
  const t = (iso) => `${iso.replace("T", " ").slice(0, 16)} UTC`;
  return `A replace from the backup of ${t(r.pointAt)} didn't finish (started ${t(r.at)})`;
}

// A backup of a gutted database looks like any other: restic saves what it's given.
// So compare with the last normal backup: under half the dump size or half the
// files is worth a look. Small apps are left alone (a few KB swing easily).
export function shrinkage(baseline, result) {
  if (!baseline) return null;
  const when = baseline.at ? ` in the backup of ${baseline.at.replace("T", " ").slice(0, 16)} UTC` : "";
  const drops = [];
  const db = result.database;
  if (db?.ok && baseline.dbBytes >= 1_000_000 && db.bytes < baseline.dbBytes / 2) {
    drops.push(`the database dump is ${formatBytes(db.bytes)}, down from ${formatBytes(baseline.dbBytes)}`);
  }
  const f = result.files;
  if (f?.ok && !f.skipped && baseline.files >= 20 && f.files < baseline.files / 2) {
    drops.push(`${f.files.toLocaleString("en-US")} files, down from ${baseline.files.toLocaleString("en-US")}`);
  }
  if (!drops.length) return null;
  return `The data shrank sharply: ${drops.join("; ")}${when}. If that wasn't deleted on purpose, check the app now: this backup may hold damaged data, and older restore points are kept until this is resolved.`;
}

function unreadableText(errors) {
  const n = errors.length;
  const items = errors.slice(0, 3).map((m) => m.item ?? m.error?.message).filter(Boolean);
  return `${n} ${n === 1 ? "file" : "files"} couldn't be read and ${n === 1 ? "is" : "are"} missing from this backup${items.length ? `: ${items.join(", ")}${n > items.length ? ", ..." : ""}` : ""}.`;
}

// Runs one part, timing it and turning unexpected errors into a failed part, so
// one failure never stops the other part or the other apps from being backed up.
async function part(app, name, onEvent, fn, isStopped = () => false) {
  const started = Date.now();
  if (isStopped()) {
    const r = { ok: false, error: "not started: the backup was stopped with Ctrl-C", seconds: 0 };
    onEvent({ type: "part-done", app, part: name, result: r });
    return r;
  }
  onEvent({ type: "part-start", app, part: name });
  let r;
  try {
    r = await fn((msg) => {
      if (msg.message_type === "status") {
        onEvent({ type: "progress", app, part: name, percent: msg.percent_done, bytesDone: msg.bytes_done ?? 0, totalBytes: msg.total_bytes ?? 0 });
      }
    });
  } catch (err) {
    r = { ok: false, error: err instanceof UserError ? err.message : String(err?.message ?? err) };
  }
  // Cut off by Ctrl-C: restic's own wording ("interrupted", exit codes) says less.
  if (!r.ok && isStopped()) r = { ok: false, error: "stopped with Ctrl-C before it finished" };
  r.seconds = Math.round((Date.now() - started) / 100) / 10;
  onEvent({ type: "part-done", app, part: name, result: r });
  return r;
}

// The most useful line from a failed run: the dump tool's own error if there is
// one (e.g. "Access denied"), otherwise restic's. restic writes its own errors to
// stderr as JSON, and prefixes a subprocess's stderr with "subprocess <name>: ".
export function describeFailure(r, tool) {
  if (r.code === null && r.signal) return `the backup program was stopped (${r.signal}) before it finished`;
  const text = [];
  const json = [...r.messages];
  for (const line of r.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    try {
      json.push(JSON.parse(line));
    } catch {
      text.push(line);
    }
  }
  const own = text.find((l) => l.includes(`${tool}: `));
  if (own) return own.slice(own.lastIndexOf(`${tool}: `) + tool.length + 2).trim();
  const err = json.find((m) => m.message_type === "exit_error") ?? json.find((m) => m.message_type === "error");
  return (err?.message ?? err?.error?.message ?? text.at(-1) ?? `exit code ${r.code}`).replace(/^Fatal: /, "");
}

// What to do about common database failures.
export function databaseHint(error, project) {
  const user = project.database.user;
  if (/insufficient privileges to SHOW CREATE (PROCEDURE|FUNCTION)/i.test(error)) {
    return `As a MySQL admin, run: GRANT SHOW_ROUTINE ON *.* TO '${user}'@'<host>';  (read-only; MariaDB: GRANT SELECT ON mysql.proc TO ...)`;
  }
  if (/Access denied/i.test(error)) return `Has the password of ${user} changed? Credentials are in ${project.database.credentials}.`;
  if (/Can't connect|Unknown MySQL server host|Lost connection/i.test(error)) return "Is the database server running and reachable from this server?";
  if (/Unknown database/i.test(error)) return `The database ${project.database.name} doesn't exist anymore. Was it renamed?`;
  return undefined;
}
