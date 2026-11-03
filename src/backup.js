// Backing up apps. Each run makes one restore point per app: a database snapshot
// and a files snapshot in restic, both tagged with the same point=<id>, so the
// database and the files can always be restored as a matching pair.
// No printing here: progress and results go to onEvent, and both `agouti backup`
// and the interactive app render them.
import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { requireConfig } from "./config.js";
import { dumpCommand } from "./mysql.js";
import { paths } from "./paths.js";
import { EXIT, ensureRestic, resticEnv, run, runJson } from "./restic.js";
import { acquireLock, recordBackup } from "./state.js";
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

  const release = lock ? await acquireLock(p) : async () => {};
  try {
    const bin = await ensureRestic({ p, log });
    const env = await resticEnv(config, p);
    const results = [];
    for (const name of selected) {
      const result = await backupApp(name, config.projects[name], { bin, env, onEvent, extraTags: tags });
      await recordBackup(name, result, p);
      results.push(result);
    }
    return results;
  } finally {
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
  };
}

export function pointId(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

async function backupApp(name, project, { bin, env, onEvent, extraTags = [] }) {
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
      const error = describeFailure(r, "mysqldump");
      return { ok: false, error, hint: databaseHint(error, project) };
    }
    return { ok: true, snapshot: r.summary.snapshot_id, bytes: r.summary.total_bytes_processed, added: r.summary.data_added };
  });

  // Files: only what changed since last time is uploaded (restic deduplicates).
  const files = await part(name, "files", onEvent, async (progress) => {
    const dirs = (project.files ?? []).map((f) => join(project.path, f));
    if (!dirs.length) return { ok: true, skipped: true };
    const missing = [];
    for (const d of dirs) if (!(await stat(d).catch(() => null))?.isDirectory()) missing.push(d);
    if (missing.length) return { ok: false, error: `Folder missing: ${missing.join(", ")}. Was it moved or deleted?` };

    const r = await runJson(bin, [...common, "--tag", [...tags, "part=files"].join(","), ...dirs], { env, onMessage: progress });
    // Exit 3: snapshot saved, but some files couldn't be read (permissions, vanished mid-backup).
    if ((r.code !== EXIT.OK && r.code !== 3) || !r.summary) return { ok: false, error: describeFailure(r, "restic") };
    const unreadable = r.messages.filter((m) => m.message_type === "error").length;
    return {
      ok: true,
      snapshot: r.summary.snapshot_id,
      files: r.summary.total_files_processed,
      bytes: r.summary.total_bytes_processed,
      added: r.summary.data_added,
      newFiles: r.summary.files_new,
      changed: r.summary.files_changed,
      ...(unreadable
        ? { warning: `${unreadable} ${unreadable === 1 ? "file" : "files"} couldn't be read and ${unreadable === 1 ? "is" : "are"} missing from this backup.` }
        : {}),
    };
  });

  // What a new server needs to restore this app after this one is lost: where it
  // lived and what to back up. Never credentials.
  let described = { ok: true };
  if (database.ok || files.ok) {
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
  onEvent({ type: "app-done", app: name, result });
  return result;
}

// Runs one part, timing it and turning unexpected errors into a failed part, so
// one failure never stops the other part or the other apps from being backed up.
async function part(app, name, onEvent, fn) {
  const started = Date.now();
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
  r.seconds = Math.round((Date.now() - started) / 100) / 10;
  onEvent({ type: "part-done", app, part: name, result: r });
  return r;
}

// The most useful line from a failed run: the dump tool's own error if there is
// one (e.g. "Access denied"), otherwise restic's. restic writes its own errors to
// stderr as JSON, and prefixes a subprocess's stderr with "subprocess <name>: ".
export function describeFailure(r, tool) {
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
