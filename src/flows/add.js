// "Add an app", interactive. Used by the app's home screen and by `agouti add`
// in a terminal. The non-interactive command calls the same core in projects.js.
import { join, resolve } from "node:path";
import { requireConfig } from "../config.js";
import { runBackup } from "./backup.js";
import { detectApp, dirStats, fileCandidates, findApps, formatBytes, suggestName } from "../detect.js";
import { readDatabaseSettings } from "../envfile.js";
import { basename } from "node:path";
import { backupUserName, backupUserSql, clientFlavor, createBackupUser, generatePassword, installClientHint, mysqlClient, query, routinesWarning, str } from "../mysql.js";
import { adminConnection } from "../restore.js";
import { askAdmin } from "./restore.js";
import { paths } from "../paths.js";
import { checkWriteAccess, findServices } from "../services.js";
import { discardDatabase, prepareDatabase, saveProject, validateAppDir, validateFolders, validateName } from "../projects.js";
import { UserError, bold, dim, info, ok, red, warn, yellow } from "../ui.js";

export class Cancelled extends Error {}

export async function addFlow(ask, { p = paths(), dir, services = findServices } = {}) {
  const config = await requireConfig(p);

  dir = await askAppDir(ask, config, dir);
  const app = await detectApp(dir);
  info(
    app.framework
      ? `\nDetected: ${bold(app.label)}`
      : `\n${yellow("⚠")} Couldn't detect the framework. You can still add the app: Agouti will ask for the details.`,
  );

  const name = await ask.input({ message: "Name for this app", default: suggestName(dir), validate: (v) => validateName(v.trim(), config) });

  let db;
  try {
    db = await askDatabase(ask, { app, name, p });
    const files = await askFiles(ask, dir, app);
    const service = await askService(ask, dir, files, services);

    info(`\n${bold(name)}  ${dim(dir)}`);
    info(`  Database  ${db.settings.database} @ ${db.settings.socket ?? `${db.settings.host}:${db.settings.port}`} as ${db.settings.username}`);
    info(`  Files     ${files.length ? files.join(", ") : dim("none (database only)")}`);
    if (service) info(`  Service   ${service} ${dim("(stopped while a restore replaces live data)")}`);
    if (!(await ask.confirm({ message: `Add ${name}?`, default: true }))) throw new Cancelled();

    await saveProject({ name, dir, framework: app.framework, db: db.settings, source: db.source, files, service }, p);
  } catch (err) {
    await discardDatabase(name, p);
    if (err instanceof Cancelled) {
      info(dim("Cancelled. Nothing was saved."));
      return null;
    }
    throw err;
  }
  ok(`Added ${bold(name)}.`);
  if (await ask.confirm({ message: "Run a first backup now?", default: true })) {
    try {
      await runBackup([name], { p });
    } catch (err) {
      // The app is saved either way; a failed first backup shouldn't undo that.
      if (!(err instanceof UserError)) throw err;
      info(`${red("✕")} ${err.message}`);
    }
  }
  return name;
}

async function askAppDir(ask, config, dir) {
  if (dir) return validateAppDir(dir, config);
  const taken = new Set(Object.values(config.projects ?? {}).map((x) => x.path));
  const found = (await findApps()).filter((a) => !taken.has(a.dir));
  if (found.length) {
    const choice = await ask.select({
      message: "Which app?",
      choices: [...found.map((a) => ({ value: a.dir, name: `${a.dir}  ${dim(a.label)}` })), { value: "", name: "Another directory..." }],
    });
    if (choice) return validateAppDir(choice, config);
  }
  for (;;) {
    const input = await ask.input({ message: "App directory", default: process.platform === "win32" ? "C:\\inetpub\\wwwroot\\" : "/var/www/", required: true });
    try {
      return await validateAppDir(input.trim(), config);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      info(`${red("✕")} ${err.message}`);
    }
  }
}

// ── Database ─────────────────────────────────────────────────────────────────

function explainEnvAccess(envFile, name, p) {
  const win = process.platform === "win32";
  const admins = win ? "Administrators" : "root";
  info(`
${yellow("⚠")} ${bold("Agouti needs this app's database connection details.")}

They're in ${bold(envFile)}. That file usually also holds the app's most
sensitive secrets: APP_KEY (decrypts sessions and encrypted data), mail and
payment API keys, cloud credentials.

${bold("If you allow it, Agouti will:")}
  • read .env once, now, and never again
  • keep only the database lines (DB_*, or DATABASE_URL: host, port,
    database, username, password); every other line is discarded
    immediately, never stored, logged or sent anywhere
  • save the database password in ${join(p.projectsDir, `${name}.cnf`)},
    readable by ${admins} only, and pass it to MySQL through that file, never
    on the command line

${bold("How serious is this?")} ${yellow("Moderate.")}
  Agouti runs as ${win ? "an administrator, and administrators" : "root, and root"} can already read .env, so this doesn't open
  a new way in. But the app's database user can usually change and delete data,
  and a copy of its password would now live in a second place on this server.

${bold("What we suggest:")} a dedicated ${bold("backup user")}.
  Backups are exactly the same, but if that password ever leaks, it can't be
  used to change or delete your data, and changing the app's own password
  later won't break your backups. Agouti can create it for you.
`);
}

async function askDatabase(ask, { app, name, p }) {
  if (app.envFile) explainEnvAccess(app.envFile, name, p);
  else info(`\n${bold("Database")}: Agouti needs the connection details for this app's MySQL/MariaDB database.`);

  for (;;) {
    const method = await ask.select({
      message: "How should Agouti connect to the database?",
      choices: [
        { value: "backup-user", name: "Create a backup user that can't change your data (recommended)", description: "Agouti creates it with a MySQL admin login, or shows you the SQL." },
        ...(app.envFile
          ? [{ value: "env", name: "Read the details from .env", description: "Uses the app's own database user. Only the database lines are kept." }]
          : []),
        { value: "manual", name: "Enter the details of an existing database user" },
        { value: "cancel", name: "Cancel" },
      ],
    });
    if (method === "cancel") throw new Cancelled();

    let settings;
    try {
      if (method === "backup-user") settings = await backupUserSetup(ask, name, p);
      if (method === "env") {
        settings = await readDatabaseSettings(app.envFile);
        info(dim(`Read from .env: ${settings.database} @ ${settings.socket ?? `${settings.host}:${settings.port}`} as ${settings.username} (password hidden)`));
      }
      if (method === "manual") settings = await askConnection(ask, {});
    } catch (err) {
      if (err instanceof UserError) {
        info(`${red("✕")} ${err.message}${err.hint ? `\n${dim(err.hint)}` : ""}`);
        continue;
      }
      throw err;
    }
    if (!settings) continue; // stepped back

    const done = await connectLoop(ask, name, settings, p);
    if (done) return { settings: done, source: method === "env" ? "env" : "manual" };
  }
}

async function backupUserSetup(ask, app, p) {
  const database = (await ask.input({ message: "Database name (the app's DB_DATABASE, DB_NAME or the end of DATABASE_URL)", required: true })).trim();
  const how = await ask.select({
    message: "Create it how?",
    choices: [
      {
        value: "agouti",
        name: "Agouti creates it now (recommended)",
        description: "Log in once as a MySQL admin (e.g. root). That password is only used for this and isn't saved.",
      },
      { value: "sql", name: "Show me the SQL, I'll run it myself" },
      { value: "back", name: "Go back" },
    ],
  });
  if (how === "back") return null;
  if (how === "agouti") return createUserNow(ask, { app, database, p });
  const password = generatePassword();
  const username = backupUserName(app);
  info(`
Run this as a MySQL admin (on most servers: ${bold(process.platform === "win32" ? `${basename(mysqlClient()).replace(/\.exe$/i, "")} -u root -p` : `sudo ${basename(mysqlClient())}`)}):

${backupUserSql({ database, username, password, flavor: await clientFlavor() })}

${dim("It can read the database (all mysqldump needs) but can't change your data: no INSERT, UPDATE, DELETE or DROP TABLE.")}
${dim("MySQL has no read-only permission for triggers and scheduled events, so to back them up it can also add or remove those.")}
${dim("The password was generated just now; Agouti will store it, you don't need to.")}
`);
  const done = await ask.select({
    message: "Done?",
    choices: [
      { value: "yes", name: "Yes, I've run it" },
      { value: "back", name: "Go back" },
    ],
  });
  if (done === "back") return null;
  return { host: "localhost", port: 3306, database, username, password };
}

// Creates the backup user through an admin login (the same one restores use: root
// through the socket on Linux, otherwise asked for). Returns its connection settings.
async function createUserNow(ask, { app, database, p }) {
  const server = { host: "localhost", port: 3306 };
  const admin = await askAdmin(ask, { database: server }, p, { need: "that can create users", cancelled: "No backup user was created." });
  const conn = await adminConnection({ database: server }, { ...admin, p });
  let user;
  try {
    const found = await query(conn.file, `SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${str(database)}`);
    if (!found.ok) throw new UserError(`Couldn't check the database: ${found.error}`);
    if (!found.rows.length) throw new UserError(`There's no database ${database} on this MySQL server.`, "Check the name (in the app's .env) and the server.");
    // On this server: a user that can only log in from it. Elsewhere: from anywhere.
    const local = !admin.host || ["localhost", "127.0.0.1", "::1"].includes(admin.host);
    user = await createBackupUser(conn.file, { app, database, host: local ? "localhost" : "%" });
  } finally {
    await conn.cleanup();
  }
  ok(`Created ${bold(user.username)}: it can read ${database} but can't change your data.`);
  if (!user.routines) warn(routinesWarning(user.username));
  return { host: admin.host ?? server.host, port: admin.port ?? server.port, database, username: user.username, password: user.password };
}

async function askConnection(ask, prev) {
  const host = (await ask.input({ message: "Host", default: prev.host ?? "127.0.0.1", required: true })).trim();
  const port = Number(await ask.input({ message: "Port", default: String(prev.port ?? 3306), validate: (v) => (/^\d+$/.test(v.trim()) ? true : "A number") }));
  const database = (await ask.input({ message: "Database name", default: prev.database, required: true })).trim();
  const username = (await ask.input({ message: "Username", default: prev.username, required: true })).trim();
  const password = await ask.password({ message: prev.password ? "Password (leave empty to keep the current one)" : "Password", mask: "*" });
  return { host, port, database, username, password: password || prev.password || "" };
}

// Tests the connection; on failure lets the user fix the details, pick another
// method, or save anyway. Returns the working settings, or null to go back.
async function connectLoop(ask, name, settings, p) {
  for (;;) {
    info(dim("Checking the connection..."));
    const { check } = await prepareDatabase(name, settings, p);
    if (check.ok) {
      ok(`Connected: ${check.version} · ${settings.database} · ${check.tables} tables · ${formatBytes(check.bytes)}`);
      if (check.tables === 0) warn("The database has no tables. Is it the right one?");
      if (!check.routinesVisible) warn(routinesWarning(settings.username));
      return settings;
    }
    if (check.clientMissing) {
      warn(`${check.message} ${installClientHint()}`);
      return settings;
    }
    info(`${red("✕")} Couldn't connect: ${check.message}`);
    const next = await ask.select({
      message: "What now?",
      choices: [
        { value: "edit", name: "Change the details" },
        { value: "back", name: "Choose another way to connect" },
        { value: "save", name: "Keep these details, I'll fix the database side later" },
        { value: "cancel", name: "Cancel" },
      ],
    });
    if (next === "cancel") throw new Cancelled();
    if (next === "back") return null;
    if (next === "save") return settings;
    settings = await askConnection(ask, settings);
  }
}

// ── Files ────────────────────────────────────────────────────────────────────

async function askFiles(ask, dir, app) {
  const candidates = await fileCandidates(dir, app.framework);
  let chosen = [];
  if (candidates.length) {
    info(dim("\nMeasuring folders..."));
    const choices = [];
    for (const c of candidates) {
      const s = c.include || c.whole ? await dirStats(join(dir, c.path)) : null;
      const detail = s ? `${formatBytes(s.bytes)} · ${s.files.toLocaleString("en-US")} ${s.files === 1 ? "file" : "files"}` : `(${c.reason})`;
      choices.push({ value: c.path, name: `${c.path.padEnd(22)} ${dim(detail)}${c.note ? dim(` · ${c.note}`) : ""}`, checked: c.include });
    }
    chosen = await ask.checkbox({ message: "Which folders hold uploaded files to back up?", choices });
  }
  for (;;) {
    const extra = await ask.input({
      message: candidates.length
        ? "Other folders to include (comma-separated, optional; a full path for one outside the app)"
        : "Folders with uploaded files (comma-separated, relative to the app or a full path; empty for none)",
    });
    try {
      const folders = await validateFolders(dir, [...chosen, ...extra.split(",")]);
      const inside = chosen.filter((f) => !folders.includes(f));
      if (inside.length) info(dim(`Already included in a chosen folder, so not listed twice: ${inside.join(", ")}`));
      if (!folders.length) warn("No folders selected: only the database will be backed up.");
      return folders;
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      info(`${red("✕")} ${err.message}`);
    }
  }
}

// ── Service ──────────────────────────────────────────────────────────────────

// The service that runs the app (Windows: found through NSSM's AppDirectory or a
// wrapper .exe in the app folder). A restore that replaces live data stops it first.
async function askService(ask, dir, files, find) {
  const found = await find(dir);
  if (!found.length) return undefined;
  const runs = (s) => `${s.name}${s.display && s.display !== s.name ? ` (${s.display})` : ""}, runs as ${s.account ?? "?"}${s.running ? "" : ", stopped now"}`;
  info(`\nThis app runs as a service: ${found.map(runs).join("; ")}.`);
  const choice = await ask.select({
    message: "Stop it while a restore replaces the app's data?",
    choices: [
      ...found.map((s) => ({ value: s.name, name: `Yes, stop ${s.name} and start it again after (recommended)`, description: "So the app doesn't write into half-restored data." })),
      { value: "", name: "No, leave it running" },
    ],
  });
  if (!choice) return undefined;
  // Can its account write into the upload folders now? If not, the app is already
  // failing to save files: better said here than found after a restore.
  const account = found.find((s) => s.name === choice).account;
  const access = await checkWriteAccess(files.map((f) => resolve(dir, f)), account).catch(() => null);
  for (const f of access ?? []) {
    if (f.ok === null) warn(`Couldn't check whether ${account} can write into ${f.folder}: ${f.error}`);
    if (f.ok === false) warn(`${account} can't write into ${f.folder}, so the app may already fail to save files there. To allow it, as an administrator: ${f.fix}`);
  }
  return choice;
}
