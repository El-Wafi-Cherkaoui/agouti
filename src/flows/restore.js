// Restoring, interactively ("Restore" in the app, or `sudo agouti restore`), and the
// output shared with `agouti restore <app> ...`.
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { mysqlClient } from "../mysql.js";
import { ago } from "../app.js";
import { requireConfig, writeAtomic } from "../config.js";
import { mkdir, readFile } from "node:fs/promises";
import { formatBytes } from "../detect.js";
import { paths } from "../paths.js";
import { isWindows } from "../platform.js";
import { adminConnection, copyDatabaseName, discoverApps, findFiles, listPoints, newestBackup, putFileBack, restoreApp, restoreFilesByPath } from "../restore.js";
import { bringBack, describeFound } from "./adopt.js";
import { clearLaravelCache } from "../laravel.js";
import { flaggedPoints } from "../state.js";
import { onDisk } from "../names.js";
import { ensureRestic, resticEnv } from "../restic.js";
import { accountSids, grantAccess, startCommand } from "../services.js";
import { UserError, bold, dim, green, info, localNote, red, shellQuote, warn, yellow } from "../ui.js";

export async function restoreFlow(ask, { p = paths(), app } = {}) {
  const config = await requireConfig(p);
  const apps = Object.keys(config.projects ?? {});
  const bin = await ensureRestic({ p, log: info });
  const env = await resticEnv(config, p);
  info(dim("Looking up restore points..."));
  // Apps in the backups but not on this server (e.g. a new server after `connect`).
  const elsewhere = (await discoverApps({ bin, env })).filter((a) => !config.projects?.[a.name]);
  if (!apps.length && !elsewhere.length) throw new UserError("There's nothing to restore yet: no app has been backed up.");
  if (!app) {
    const choices = [
      ...apps.map((a) => ({ value: a, name: a })),
      ...elsewhere.map((a) => ({ value: a.name, name: `${a.name}  ${dim("(in the backups, not on this server yet)")}`, description: describeFound(a) })),
    ];
    app = choices.length === 1 ? choices[0].value : await ask.select({ message: "Restore which app?", choices });
  }
  const other = elsewhere.find((a) => a.name === app);
  if (other) return bringBack(ask, other, { p });
  const project = config.projects[app];
  if (!project) throw new UserError(`Unknown app: ${app}`, `Apps: ${[...apps, ...elsewhere.map((a) => a.name)].join(", ") || "none"}`);

  const points = await listPoints(app, { bin, env, flagged: await flaggedPoints(app, p) });
  if (!points.length) throw new UserError(`${app} has no restore points yet.`, `Make one first: "Back up now", or sudo agouti backup ${app}`);
  await adminNotice(project, p);

  const newest = newestBackup(points);
  const point = await ask.select({
    message: "Which restore point?",
    pageSize: 12,
    default: newest,
    choices: points.map((pt) => ({ value: pt, name: pointLabel(pt, pt === newest), description: pointDetails(pt) })),
  });

  const what = await ask.select({
    message: "What do you want to restore?",
    choices: [
      ...(point.database && point.files ? [{ value: "all", name: "Everything (database + files)" }] : []),
      ...(point.database ? [{ value: "database", name: "Only the database" }] : []),
      ...(point.files ? [{ value: "files", name: "Only the files" }] : []),
      ...(point.files ? [{ value: "file", name: "A single file", description: "Find it by name; it's restored next to the live one." }] : []),
      { value: "cancel", name: "Cancel" },
    ],
  });
  if (what === "cancel") return;
  if (what === "file") return singleFile(ask, { app, project, point, bin, env, p });
  const parts = what === "all" ? ["database", "files"] : [what];

  const mode = await ask.select({
    message: "How?",
    choices: [
      {
        value: "copy",
        name: "As a copy, next to the live data (safe)",
        description: [
          parts.includes("database") ? `Database into ${copyDatabaseName(project.database.name, point.id)}` : null,
          parts.includes("files") ? `files into ${join(p.dataDir, "restores")}` : null,
        ]
          .filter(Boolean)
          .join(", ")
          .concat(". Nothing live is touched."),
      },
      { value: "replace", name: "Replace the live data", description: "Overwrites what the app uses now. A restore point of the current state is made first." },
    ],
  });

  if (mode === "replace" && !(await confirmReplace(ask, app, project, parts, point))) return info("Nothing was changed.");
  const admin = parts.includes("database") ? await askAdmin(ask, project, p) : undefined;
  info("");
  const result = await runRestore({ app, point: point.id, parts, mode, admin }, { p });
  await fixAccess(ask, result);
  await afterReplace(ask, project, result);
}

// Restored folders the app's service account can't write into: offer to grant it.
export async function fixAccess(ask, result) {
  const access = result?.files?.access;
  for (const f of access?.folders ?? []) if (f.ok === null) warn(`Couldn't check whether ${access.account} can write into ${f.folder}: ${f.error}`);
  const blocked = access?.folders.filter((f) => f.ok === false) ?? [];
  if (!blocked.length) return;
  warn(`${access.account} (the account ${result.service.name} runs as) can't write into: ${blocked.map((f) => f.folder).join(", ")}. The app may fail to save uploads.`);
  if (!(await ask.confirm({ message: `Give ${access.account} write access there now?`, default: true }))) {
    return info(dim(`To do it yourself, as an administrator:\n${blocked.map((f) => `  ${f.fix}`).join("\n")}`));
  }
  for (const f of blocked) {
    try {
      grantAccess(f.folder, accountSids(access.account)[0]);
      info(`${green("✓")} ${access.account} can write into ${bold(f.folder)}`);
    } catch (err) {
      warn(`${err.message}. Run it yourself: ${f.fix}`);
    }
  }
}

// After the live database was replaced: a Laravel app may still serve cached data
// from before. Offer to clear the cache now, and say plainly what skipping means.
export async function afterReplace(ask, project, result) {
  if (result?.mode !== "replace" || !result.database?.ok || project?.framework !== "laravel") return;
  const stale = "Until it's cleared, the app may show data from before the restore (Laravel keeps cached results outside the database).";
  if (!(await ask.confirm({ message: "Clear the app's Laravel cache now? (php artisan cache:clear)", default: true }))) {
    return warn(`${stale} Clear it yourself: cd ${project.path} && php artisan cache:clear, as the app's user.`);
  }
  const r = await clearLaravelCache(project.path);
  if (r.ok) return info(`${green("✓")} Laravel's cache cleared (as ${r.owner})`);
  warn(`Couldn't clear the cache: ${r.error}. ${stale} Run it yourself, as ${r.owner}: cd ${project.path} && php artisan cache:clear`);
}

export function pointLabel(pt, latest = false) {
  const when = `${pt.at.replace("T", " ").slice(0, 16)} UTC${dim(localNote(pt.at))}`;
  const parts = pt.database && pt.files ? "database + files" : pt.database ? yellow("database only") : yellow("files only");
  const notes = [latest && "latest", pt.safety && "saved before a restore"].filter(Boolean);
  return `${when}  ${dim(ago(pt.at).padEnd(11))} ${parts}${notes.length ? dim(`  (${notes.join(", ")})`) : ""}${flagNote(pt)}`;
}

export // Suspect data: the backup shrank sharply, or was taken during an unfinished replace.
const FLAGS = { shrank: "data shrank sharply", "half-restored": "taken during an unfinished replace" };
const flagNote = (pt) => (pt.flagged ? `  ${yellow(`⚠ ${FLAGS[pt.flagged] ?? pt.flagged}`)}` : "");

export function pointDetails(pt) {
  const bits = [];
  if (pt.database) bits.push(`database dump ${formatBytes(pt.database.bytes ?? 0)}`);
  else bits.push("the database part of this backup failed");
  const n = pt.files?.files ?? 0;
  if (pt.files) bits.push(`${n.toLocaleString("en-US")} ${n === 1 ? "file" : "files"}, ${formatBytes(pt.files.bytes ?? 0)}`);
  return `${bits.join(" · ")} · ${pt.id}`;
}

async function confirmReplace(ask, app, project, parts, point) {
  info(`
${yellow("⚠")} ${bold("This replaces live data")} with the state of ${point.at.replace("T", " ").slice(0, 16)} UTC${localNote(point.at)}:
${parts.includes("database") ? `  · database ${bold(project.database.name)}: dropped and recreated from the backup. Changes made since are lost.\n` : ""}${
    parts.includes("files") ? `  · ${project.files.map((f) => bold(f)).join(", ")}: made identical to the backup. Files added since are deleted${project.exclude?.length ? ", except those left out by exclude rules, which stay as they are" : ""}.\n` : ""
  }
${parts.includes("database") ? "Agouti first tries this backup in a throwaway database, and stops if it doesn't load.\n" : ""}Before replacing, it makes a restore point of the current state, so this can be undone.
${project.service ? `${bold(project.service)} is stopped while the data is replaced, and started again after.` : "Put the app in maintenance mode first if it's live (Laravel: php artisan down)."}
`);
  const typed = await ask.input({ message: `Type ${bold(app)} to confirm (anything else cancels)` });
  return typed.trim() === app;
}

// Finds a MySQL user that can create databases: root through the local socket
// (or, on Windows, root without a password), or one the user gives. Returns
// { user, password, host, port } for adminConnection, or {} for root as is.
// need: what the admin must be able to do; cancelled: the message when they give up.
//
// A login given here is kept in memory for the rest of this run (one menu session),
// per MySQL server, so a copy restore followed by a replace asks once. Only the
// server and user name are saved, as next time's defaults; never the password.
const session = new Map();
const LOCAL = ["localhost", "127.0.0.1", "::1"];
const serverKey = (db) => (db.socket ? `socket:${db.socket}` : `${LOCAL.includes(db.host) ? "local" : db.host}:${db.port ?? 3306}`);
const defaultsFile = (p) => join(p.dataDir, "admin-login.json");

// For tests: as if Agouti had just started.
export const forgetAdminLogins = () => session.clear();

export async function askAdmin(ask, project, p, { need = "that can create databases", cancelled = "Restore cancelled: no MySQL user to restore with." } = {}) {
  const key = serverKey(project.database);
  const kept = session.get(key);
  if (kept) {
    if (await canConnect(project, { ...kept, p })) {
      info(dim(`Using the MySQL login ${kept.user} given earlier (kept in memory until Agouti closes).`));
      return kept;
    }
    session.delete(key); // its password changed meanwhile
  }
  if (await canConnect(project, { p })) return {};

  const saved = (await loadDefaults(p))[key];
  info(`
This needs a MySQL admin ${need}. ${isWindows() ? "Logging in as root without a\npassword didn't work" : "Logging in as root through\nthe local socket didn't work"}, so give a MySQL admin login (and its server).
`);
  explainAdminPassword(p);
  const db = project.database;
  for (;;) {
    const server = (
      await ask.input({ message: "MySQL server (host or host:port)", default: saved?.server ?? (db.port && db.port !== 3306 ? `${db.host}:${db.port}` : db.host) })
    ).trim();
    const [host, port = "3306"] = server.split(":");
    const user = (await ask.input({ message: "MySQL admin user", default: saved?.user ?? "root" })).trim();
    const password = await ask.password({ message: `Password of ${user}`, mask: "*" });
    const login = { user, password, host, port: Number(port) };
    try {
      const conn = await adminConnection(project, { ...login, p });
      await conn.cleanup();
      session.set(key, login);
      await saveDefaults(p, key, { server, user });
      return login;
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      info(`${red("✕")} ${err.message}`);
      if (!(await ask.confirm({ message: "Try again?", default: true }))) throw new UserError(cancelled);
    }
  }
}

// What happens to the admin password, said before it's typed.
function explainAdminPassword(p) {
  const admins = isWindows() ? "Administrators" : "root";
  info(`${bold("How Agouti handles this password:")}
  • It's used only for what you're doing now, and never saved: not in Agouti's
    settings or credentials files, not in logs, alerts or backups.
  • While it's needed, it's in a temporary file readable by ${admins} only
    (${join(p.dataDir, "restore-admin-<number>.cnf")}). MySQL reads it from
    there, so it never appears on a command line or in the list of running
    programs. The file is deleted as soon as the work is done (or, if Agouti was
    cut off, the next time it needs an admin login).
  • Until you quit Agouti, it stays in memory, so you aren't asked again.
    Next time, the server and user name are filled in for you; the password isn't.
  • Only * is shown as you type.
`);
}

async function canConnect(project, opts) {
  try {
    const conn = await adminConnection(project, opts);
    await conn.cleanup();
    return true;
  } catch (err) {
    if (!(err instanceof UserError) || /isn't installed/.test(err.message)) throw err;
    return false;
  }
}

// Before the questions: say a database restore will need an admin password, so it
// doesn't come as a surprise after choosing a restore point. Never fails.
export async function adminNotice(project, p) {
  try {
    if (session.has(serverKey(project.database)) || (await canConnect(project, { p }))) return;
  } catch {
    return; // no mysql client: the restore itself says so
  }
  info(dim(`Restoring the database will ask for a MySQL admin password (e.g. root's): root can't log in here without one. Restoring files doesn't need it.\n`));
}

async function loadDefaults(p) {
  try {
    return JSON.parse(await readFile(defaultsFile(p), "utf8"));
  } catch {
    return {};
  }
}

async function saveDefaults(p, key, value) {
  try {
    const all = await loadDefaults(p);
    all[key] = value;
    await mkdir(p.dataDir, { recursive: true });
    await writeAtomic(defaultsFile(p), JSON.stringify(all, null, 2) + "\n", 0o600);
  } catch {
    // only a convenience
  }
}

async function singleFile(ask, { app, project, point, bin, env, p }) {
  for (;;) {
    const text = await ask.input({
      message: "Part of the file's name or path (e.g. invoice-1042)",
      validate: (v) => v.trim().length > 0 || "Type part of the name.",
    });
    const matches = await findFiles(point, text.trim(), { bin, env });
    if (!matches.length) {
      warn(`No file in this restore point matches "${text}".`);
      continue;
    }
    const choice = await ask.select({
      message: `${matches.length === 30 ? "First 30 matches" : `${matches.length} ${matches.length === 1 ? "match" : "matches"}`}. Which file?`,
      pageSize: 12,
      choices: [
        ...matches.map((m) => ({
          value: m.path,
          name: outsideApp(project.path, m.path) ? m.path : relative(project.path, m.path),
          description: `${formatBytes(m.size ?? 0)} · modified ${m.mtime?.slice(0, 16).replace("T", " ")}`,
        })),
        { value: "", name: dim("Search again") },
      ],
    });
    if (!choice) continue;
    const [restored] = await restoreFilesByPath(app, point.id, [choice], { p });
    info(`${green("✓")} Restored to ${bold(String(restored))}`);
    const live = await livePathFor(choice, restored);
    const exists = Boolean(await onDisk(choice));
    const rel = relative(project.path, choice);
    const keepAt = join(p.dataDir, "restores", `${app}-replaced-${stamp()}`, outsideApp(project.path, choice) ? basename(choice) : rel);
    const put = await ask.select({
      message: exists ? "Put it back in the app, replacing the live file?" : "Put it back in the app? (it's no longer there)",
      choices: [
        {
          value: "put",
          name: exists ? "Yes, replace the live file" : "Yes, put it back",
          description: exists ? `The live file is kept first, in ${dirname(keepAt)}.` : `Back to ${String(live)}.`,
        },
        { value: "keep", name: "No, just keep the copy" },
      ],
    });
    if (put === "keep") {
      info(dim(`The live file was not touched. To put it back yourself:\n  ${isWindows() ? `copy /Y ${shellQuote(restored)} ${shellQuote(live)}` : `sudo cp -a ${shellQuote(restored)} ${shellQuote(live)}`}`));
      return;
    }
    try {
      const { kept } = await putFileBack({ restored, live, keepAt });
      info(`${green("✓")} Put back: ${bold(String(live))} ${dim(`(as it was on ${point.at.replace("T", " ").slice(0, 16)} UTC)`)}`);
      if (kept) info(dim(`The file it replaced is kept in ${kept}. Delete it when you no longer need it.`));
    } catch (err) {
      const busy = ["EBUSY", "EPERM", "EACCES"].includes(err.code);
      warn(`Couldn't put it back: ${err.message}${busy ? " (is the app using the file right now?)" : ""}. The live file wasn't changed; the restored copy is at ${String(restored)}.`);
    }
    return;
  }
}

// "20261109-1015" (UTC), for folders that must not collide.
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

// Runs a restore and prints it. Returns the result.
export async function runRestore(opts, { p = paths(), live = process.stdout.isTTY } = {}) {
  let line = false;
  const clear = () => {
    if (line) process.stdout.write("\r\x1b[2K");
    line = false;
  };
  const result = await restoreApp(opts, {
    p,
    log: info,
    onEvent: (e) => {
      if (e.type === "check-start") info(dim("Trying this backup in a throwaway database first, so nothing live is at risk..."));
      if (e.type === "check-failed") clear();
      if (e.type === "check-done") {
        clear();
        info(`${green("✓")} The backup loads correctly`);
      }
      if (e.type === "safety-start") info(dim("Saving the current state first, so this can be undone..."));
      if (e.type === "service-stop") info(dim(`Stopping ${e.name}, so the app doesn't write while its data is replaced...`));
      if (e.type === "service-not-running") info(dim(e.exists ? `${e.name} isn't running: nothing to stop.` : `There's no service ${e.name} on this server: the app isn't stopped during the restore.`));
      if (e.type === "service-start") info(dim(`Starting ${e.name} again...`));
      if (e.type === "service-started") {
        clear();
        if (e.service.started) info(`${green("✓")} ${e.service.name} is running again`);
        else info(`${red("✕")} ${e.service.error}. Start it yourself: ${bold(startCommand(e.service.name))}`);
      }
      if (e.type === "part-start" && opts.mode === "replace") info(`Replacing the live ${e.part}${e.part === "database" ? "" : " (the backed-up folders)"}... ${dim("(from here, Ctrl-C asks before stopping)")}`);
      if (e.type === "safety-done") {
        const r = e.result;
        if (r.ok) info(`${green("✓")} Current state saved: restore point ${bold(r.point)}`);
      }
      if (e.type === "progress" && live) {
        const amount = e.totalBytes
          ? `${Math.min(100, Math.floor((e.percent ?? 0) * 100))}% · ${formatBytes(e.bytesDone)} of ${formatBytes(e.totalBytes)}`
          : formatBytes(e.bytesDone);
        process.stdout.write(`\r\x1b[2K  ${dim(e.part.padEnd(9))} ${dim(amount)}`);
        line = true;
      }
      if (e.type === "interrupt-warning") {
        clear();
        info(`\n${yellow("⚠")} Live data is being replaced. Stopping now would leave it half-restored.`);
        info(dim("  Press Ctrl-C again to stop anyway."));
      }
      if (e.type === "stopped") {
        clear();
        info(`\n${red("✕")} Restore stopped.`);
        if (e.touchedLive) {
          info(`  The live data may be incomplete.`);
          if (e.safety) info(`  Put back the state from before the restore: ${bold(`sudo agouti restore ${e.app} --point ${e.safety} --replace`)}`);
        } else info(dim("  Nothing live was touched."));
      }
      if (e.type === "part-done") {
        clear();
        info(`  ${partLine(e.part, e.result, opts.mode)}`);
        if (e.result.hint) info(`    ${dim(e.result.hint)}`);
      }
    },
  });
  info(
    result.ok
      ? `${green("✓")} Restored ${bold(`${result.app} @ ${result.at.replace("T", " ").slice(0, 16)}`)} ${dim("(UTC)")}`
      : `${red("✕")} The restore didn't complete.`,
  );
  nextSteps(result, opts.admin);
  return result;
}

function partLine(part, r, mode) {
  const label = part.padEnd(9);
  const secs = dim(`${r.seconds}s`);
  if (!r.ok) return `${red("✕")} ${label} ${r.error}`;
  if (part === "database") {
    const where = mode === "replace" ? `${bold(r.database)} replaced` : `restored into ${bold(r.database)}`; // new: into the (empty) database
    return `${green("✓")} ${label} ${where} · ${r.tables} of ${r.expectedTables} tables · ${secs}`;
  }
  const count = `${(r.files ?? 0).toLocaleString("en-US")} ${r.files === 1 ? "file" : "files"} · ${formatBytes(r.bytes ?? 0)}`;
  if (mode === "replace") return `${green("✓")} ${label} ${r.folders} ${r.folders === 1 ? "folder" : "folders"} replaced · ${count} · ${secs}`;
  if (mode === "new") return `${green("✓")} ${label} ${count} → ${r.paths.map((x) => bold(x)).join(", ")} · ${secs}`;
  return `${green("✓")} ${label} ${count} → ${bold(r.path)} · ${secs}`;
}

// The mysql command to look at a restored copy, with the login the restore used.
export function mysqlLookCommand(database, admin = {}, { windows = isWindows(), client = basename(mysqlClient()).replace(/\.exe$/i, "") } = {}) {
  const args = [client];
  if (admin.user || windows) args.push(`-u ${admin.user ?? "root"}`, "-p");
  if (admin.host && admin.host !== "localhost") args.push(`-h ${admin.host}`);
  if (admin.port && admin.port !== 3306) args.push(`-P ${admin.port}`);
  return [...args, database].join(" ");
}

function nextSteps(r, admin) {
  const lines = [];
  if (r.mode === "copy") {
    if (r.database?.ok) {
      lines.push(`Look at the database: ${mysqlLookCommand(r.database.database, admin)}`);
      lines.push(`Drop it when you're done: DROP DATABASE \`${r.database.database}\`;`);
    }
    if (r.files?.ok) lines.push(`Copy back what you need from ${r.files.path}${isWindows() ? "" : " (sudo cp -a keeps owners)"}, then delete it.`);
  } else if (r.mode === "replace") {
    if (r.safety?.ok) lines.push(`To undo: sudo agouti restore ${r.app} --point ${r.safety.point} --replace`);
    for (const f of r.files?.access?.folders ?? []) if (f.ok === false) lines.push(`${r.files.access.account} can't write into ${f.folder}. As an administrator: ${f.fix}`);
    // With a service, Agouti stopped and started the app itself.
    if (r.ok && !r.service && r.framework !== "laravel") lines.push("Clear the app's caches if it has any, then bring it back up.");
    if (r.ok && !r.service && r.framework === "laravel") lines.push("Bring the app back up (php artisan up) once you've checked it.");
  }
  if (lines.length) info(dim(`\n${lines.join("\n")}`));
}

// Where the restored file goes back to, byte for byte: the live file if it's there
// (its listed name may have lost bytes), else its folder plus the restored name.
async function livePathFor(listed, restored) {
  const live = await onDisk(listed);
  if (live) return live;
  if (isWindows()) return join(dirname(listed), basename(String(restored))); // Windows names are always valid text
  const folder = (await onDisk(dirname(listed))) ?? dirname(listed);
  const name = Buffer.isBuffer(restored) ? restored.subarray(restored.lastIndexOf(0x2f) + 1) : Buffer.from(basename(restored));
  return Buffer.concat([Buffer.from(String(folder) === "/" ? "" : folder), Buffer.from("/"), name]);
}

export function printPoints(app, points) {
  if (!points.length) return info(`${app} has no restore points yet.`);
  info(dim(`  ${"POINT".padEnd(18)}${"WHEN (UTC)".padEnd(18)}CONTENTS`));
  for (const pt of points) {
    const parts = pt.database && pt.files ? "database + files" : pt.database ? "database only" : "files only";
    info(`  ${pt.id.padEnd(18)}${pt.at.replace("T", " ").slice(0, 16).padEnd(18)}${parts}${localNote(pt.at)}${pt.safety ? "  (saved before a restore)" : ""}${flagNote(pt)}`);
  }
}

// A file in a folder kept outside the app (or on another drive, on Windows).
const outsideApp = (dir, path) => {
  const rel = relative(dir, path);
  return rel.startsWith("..") || isAbsolute(rel);
};
