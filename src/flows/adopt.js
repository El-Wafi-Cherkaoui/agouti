// Bringing apps back on a new server: after `agouti connect`, the apps found in
// the backups are restored here (into empty folders and an empty database) and set
// up to be backed up again, as they were on the old server.
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ago } from "../app.js";
import { requireConfig } from "../config.js";
import { createBackupUser } from "../mysql.js";
import { paths } from "../paths.js";
import { prepareDatabase, saveProject } from "../projects.js";
import { adminConnection, discoverApps, listPoints, newestBackup } from "../restore.js";
import { ensureRestic, resticEnv } from "../restic.js";
import { scheduledTime } from "../schedule.js";
import { UserError, bold, dim, info, ok, red, warn } from "../ui.js";
import { askAdmin, pointDetails, pointLabel, runRestore } from "./restore.js";
import { scheduleFlow } from "./schedule.js";

// Apps in the backups that aren't set up on this server.
export async function appsToBringBack(p) {
  const config = await requireConfig(p);
  const bin = await ensureRestic({ p, log: info });
  const found = await discoverApps({ bin, env: await resticEnv(config, p) });
  return found.filter((a) => !config.projects?.[a.name]);
}

export function describeFound(a) {
  const d = a.description;
  return `${d.path || "?"} · database ${d.database.name} · last backup ${ago(a.at)} on ${a.host}`;
}

// Right after connecting to an existing repository.
export async function offerBringBack(ask, { p = paths() } = {}) {
  info(dim("Looking for apps in the backups..."));
  const found = await appsToBringBack(p);
  if (!found.length) return info(dim("No apps in these backups yet. Add one from the home screen."));
  info(`\nFound ${found.length} ${found.length === 1 ? "app" : "apps"} in the backups:`);
  for (const a of found) info(`  ${bold(a.name.padEnd(12))} ${dim(describeFound(a))}`);
  info("");
  if (!(await ask.confirm({ message: `Restore ${found.length === 1 ? "it" : "them"} on this server now?`, default: true }))) {
    return info(dim("You can do it later: sudo agouti → Restore."));
  }
  for (const a of found) {
    if (found.length > 1 && !(await ask.confirm({ message: `Restore ${a.name}?`, default: true }))) continue;
    try {
      await bringBack(ask, a, { p });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      info(`${red("✕")} ${err.message}`);
      if (err.hint) info(dim(err.hint));
    }
  }
}

// Restores one app found in the backups onto this server, then sets it up.
export async function bringBack(ask, found, { p = paths() } = {}) {
  const d = found.description;
  info(`\n${bold(found.name)}: last backed up ${ago(found.at)} on ${found.host}`);
  if (d.guessed) warn("These backups predate app descriptions: the folder and database below are Agouti's best guess. Check them.");

  // A new server needs both parts. By default the newest real backup that has them:
  // not one saved before a restore, and not one cut short by a failure.
  const parts = d.files?.length ? ["database", "files"] : ["database"];
  const point = await choosePoint(ask, found.name, parts, p);

  const dir = (
    await ask.input({
      message: `Where should ${found.name} go on this server?`,
      default: d.path || undefined,
      validate: (v) => isAbsolute(v.trim()) || "Give an absolute path, e.g. /var/www/shop",
    })
  ).trim();

  // `git clone` refuses a folder that isn't empty, so code first, then restore.
  const codeThere = (await readdir(dir).catch(() => [])).some((e) => e !== "storage");
  if (!codeThere) {
    info(`
${dim(`There's no code in ${dir} yet. Backups hold the database and uploaded files, not the code.`)}
${dim("Deploying first is easier: `git clone` refuses a folder that isn't empty.")}`);
    const next = await ask.select({
      message: "What now?",
      choices: [
        { value: "stop", name: "Stop here: I'll deploy the code first, then come back", description: "sudo agouti → Restore" },
        { value: "go", name: "Restore now anyway", description: "Then clone the code elsewhere and move the restored folders into it." },
      ],
    });
    if (next === "stop") return info(dim(`Deploy the code into ${dir}, then run sudo agouti → Restore → ${found.name}.`));
  }

  const dbName = (
    await ask.input({
      message: "Database name on this server",
      default: d.database.name,
      validate: (v) => /^[A-Za-z0-9_$-]{1,64}$/.test(v.trim()) || "Letters, digits, _ and $ only (up to 64).",
    })
  ).trim();
  // This server's MySQL, through the local socket unless an admin user says otherwise.
  const project = { path: dir, database: { engine: "mysql", name: dbName, host: "localhost", port: 3306 }, files: d.files };
  const admin = await askAdmin(ask, project, p);
  if (admin.host) Object.assign(project.database, { host: admin.host, port: admin.port });

  info(`
Agouti will restore ${bold(found.name)} as it was on ${bold(when(point))}:
  · database ${bold(dbName)} on this server (created if needed; must be empty)
  · ${d.files.map((f) => bold(join(dir, f))).join(", ") || "no folders"} (must be empty)
`);
  if (!(await ask.confirm({ message: "Go ahead?", default: true }))) return info("Nothing was changed.");

  const result = await runRestore({ app: found.name, mode: "new", project, origin: d.path, admin, point: point.id, parts }, { p });
  if (!result.ok) return;

  if (await ask.confirm({ message: `Keep backing up ${found.name} on this server? (creates a read-only MySQL user for it)`, default: true })) {
    await setUp(found.name, { dir, d, project, admin, p });
    const config = await requireConfig(p);
    if (!scheduledTime(config) && (await ask.confirm({ message: "Turn on daily automatic backups?", default: true }))) await scheduleFlow(ask, { p });
  }

  const steps = [
    ...(codeThere ? [] : [`Deploy ${found.name}'s code into ${dir}.`]),
    ...(d.framework === "laravel" ? ["Install it as usual (composer install, php artisan storage:link)."] : []),
    `In its .env, set DB_DATABASE=${dbName} and a database user that can write: the old server's MySQL users aren't in the backup.`,
    "Point the domain at this server.",
  ];
  info(dim(`\nNext:\n${steps.map((x, i) => `  ${i + 1}. ${x}`).join("\n")}`));
}

const when = (pt) => `${pt.at.replace("T", " ").slice(0, 16)} UTC`;

// Asked only when there's a choice. Incomplete points are listed but can't be picked.
async function choosePoint(ask, app, parts, p) {
  const config = await requireConfig(p);
  const points = await listPoints(app, { bin: await ensureRestic({ p, log: info }), env: await resticEnv(config, p) });
  const best = newestBackup(points, parts);
  if (!best) {
    throw new UserError(
      `No backup of ${app} has ${parts.join(" and ")}: each one is incomplete or was saved before a restore.`,
      "Check the backups on the old server, if it still runs, or restore a part by hand.",
    );
  }
  if (points.length === 1) return best;
  if (best !== points[0]) info(dim(`The newest restore point isn't a complete backup, so ${when(best)} is suggested.`));
  return ask.select({
    message: "Which restore point?",
    pageSize: 12,
    default: best,
    choices: points.map((pt) => ({
      value: pt,
      name: pointLabel(pt, pt === best),
      description: pointDetails(pt),
      disabled: !parts.every((part) => pt[part]) && `(no ${parts.find((part) => !pt[part])}: that part of the backup failed)`,
    })),
  });
}

// Registers the restored app with a dedicated read-only backup user.
async function setUp(name, { dir, d, project, admin, p }) {
  const conn = await adminConnection(project, { ...admin, p });
  let user;
  try {
    const local = ["localhost", "127.0.0.1", "::1"].includes(project.database.host) && !admin.host;
    user = await createBackupUser(conn.file, { app: name, database: project.database.name, host: local ? "localhost" : "%" });
  } finally {
    await conn.cleanup();
  }
  const db = { host: project.database.host, port: project.database.port, database: project.database.name, username: user.username, password: user.password };
  const { check } = await prepareDatabase(name, db, p);
  if (!check.ok) throw new UserError(`The new backup user can't connect: ${check.message}`);
  await saveProject({ name, dir, framework: d.framework, db, source: "restored", files: d.files, exclude: d.exclude }, p);
  ok(`${bold(name)} is set up on this server (backup user ${user.username}, read-only).`);
  if (!user.routines) warn("The backup user can't see stored procedures, so backups would leave them out. Grant SHOW_ROUTINE if you use any.");
}
