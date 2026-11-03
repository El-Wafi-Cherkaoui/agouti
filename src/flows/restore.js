// Restoring, interactively ("Restore" in the app, or `sudo agouti restore`), and the
// output shared with `agouti restore <app> ...`.
import { relative } from "node:path";
import { ago } from "../app.js";
import { requireConfig } from "../config.js";
import { formatBytes } from "../detect.js";
import { paths } from "../paths.js";
import { adminConnection, copyDatabaseName, discoverApps, findFiles, listPoints, restoreApp, restoreFilesByPath } from "../restore.js";
import { bringBack, describeFound } from "./adopt.js";
import { ensureRestic, resticEnv } from "../restic.js";
import { UserError, bold, dim, green, info, red, warn, yellow } from "../ui.js";

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

  const points = await listPoints(app, { bin, env });
  if (!points.length) throw new UserError(`${app} has no restore points yet.`, `Make one first: "Back up now", or sudo agouti backup ${app}`);

  const point = await ask.select({
    message: "Which restore point?",
    pageSize: 12,
    choices: points.map((pt, i) => ({ value: pt, name: pointLabel(pt, i === 0), description: pointDetails(pt) })),
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
          parts.includes("files") ? "files into /var/lib/agouti/restores" : null,
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
  await runRestore({ app, point: point.id, parts, mode, admin }, { p });
}

export function pointLabel(pt, latest = false) {
  const when = `${pt.at.replace("T", " ").slice(0, 16)} UTC`;
  const parts = pt.database && pt.files ? "database + files" : pt.database ? yellow("database only") : yellow("files only");
  const notes = [latest && "latest", pt.safety && "saved before a restore"].filter(Boolean);
  return `${when}  ${dim(ago(pt.at).padEnd(11))} ${parts}${notes.length ? dim(`  (${notes.join(", ")})`) : ""}`;
}

function pointDetails(pt) {
  const bits = [];
  if (pt.database) bits.push(`database dump ${formatBytes(pt.database.bytes ?? 0)}`);
  else bits.push("the database part of this backup failed");
  const n = pt.files?.files ?? 0;
  if (pt.files) bits.push(`${n.toLocaleString("en-US")} ${n === 1 ? "file" : "files"}, ${formatBytes(pt.files.bytes ?? 0)}`);
  return `${bits.join(" · ")} · ${pt.id}`;
}

async function confirmReplace(ask, app, project, parts, point) {
  info(`
${yellow("⚠")} ${bold("This replaces live data")} with the state of ${point.at.replace("T", " ").slice(0, 16)} UTC:
${parts.includes("database") ? `  · database ${bold(project.database.name)}: dropped and recreated from the backup. Changes made since are lost.\n` : ""}${
    parts.includes("files") ? `  · ${project.files.map((f) => bold(f)).join(", ")}: made identical to the backup. Files added since are deleted.\n` : ""
  }
Before that, Agouti makes a restore point of the current state, so this can be undone.
Put the app in maintenance mode first if it's live (Laravel: php artisan down).
`);
  const typed = await ask.input({ message: `Type ${bold(app)} to confirm (anything else cancels)` });
  return typed.trim() === app;
}

// Finds a MySQL user that can create databases: root through the local socket,
// or one the user gives. Returns { user, password } for restoreApp.
export async function askAdmin(ask, project, p) {
  try {
    const conn = await adminConnection(project, { p });
    await conn.cleanup();
    return {};
  } catch (err) {
    if (!(err instanceof UserError) || /isn't installed/.test(err.message)) throw err;
  }
  info(`
Restoring a database needs a MySQL user that can create databases. Logging in
as root through the local socket didn't work, so give one (and its server).
The password is only used for this restore and isn't saved.
`);
  const db = project.database;
  for (;;) {
    const server = (
      await ask.input({ message: "MySQL server (host or host:port)", default: db.port && db.port !== 3306 ? `${db.host}:${db.port}` : db.host })
    ).trim();
    const [host, port = "3306"] = server.split(":");
    const user = await ask.input({ message: "MySQL admin user", default: "root" });
    const password = await ask.password({ message: `Password of ${user}`, mask: "*" });
    try {
      const conn = await adminConnection(project, { user, password, host, port: Number(port), p });
      await conn.cleanup();
      return { user, password, host, port: Number(port) };
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      info(`${red("✕")} ${err.message}`);
      if (!(await ask.confirm({ message: "Try again?", default: true }))) throw new UserError("Restore cancelled: no MySQL user to restore with.");
    }
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
          name: relative(project.path, m.path),
          description: `${formatBytes(m.size ?? 0)} · modified ${m.mtime?.slice(0, 16).replace("T", " ")}`,
        })),
        { value: "", name: dim("Search again") },
      ],
    });
    if (!choice) continue;
    const [restored] = await restoreFilesByPath(app, point.id, [choice], { p });
    info(`${green("✓")} Restored to ${bold(restored)}`);
    info(dim(`The live file was not touched. To put it back:\n  cp -a '${restored}' '${choice}'`));
    return;
  }
}

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
      if (e.type === "safety-start") info(dim("Saving the current state first, so this can be undone..."));
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
  nextSteps(result);
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

function nextSteps(r) {
  const lines = [];
  if (r.mode === "copy") {
    if (r.database?.ok) {
      lines.push(`Look at the database: mysql ${r.database.database}`);
      lines.push(`Drop it when you're done: DROP DATABASE \`${r.database.database}\`;`);
    }
    if (r.files?.ok) lines.push(`Copy back what you need from ${r.files.path} (cp -a keeps owners), then delete it.`);
  } else if (r.mode === "replace") {
    if (r.safety?.ok) lines.push(`To undo: sudo agouti restore ${r.app} --point ${r.safety.point} --replace`);
    if (r.ok) lines.push("Clear the app's caches if it has any (Laravel: php artisan cache:clear), then bring it back up.");
  }
  if (lines.length) info(dim(`\n${lines.join("\n")}`));
}

export function printPoints(app, points) {
  if (!points.length) return info(`${app} has no restore points yet.`);
  info(dim(`  ${"POINT".padEnd(18)}${"WHEN (UTC)".padEnd(18)}CONTENTS`));
  for (const pt of points) {
    const parts = pt.database && pt.files ? "database + files" : pt.database ? "database only" : "files only";
    info(`  ${pt.id.padEnd(18)}${pt.at.replace("T", " ").slice(0, 16).padEnd(18)}${parts}${pt.safety ? "  (saved before a restore)" : ""}`);
  }
}
