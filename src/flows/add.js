// "Add an app", interactive. Used by the app's home screen and by `agouti add`
// in a terminal. The non-interactive command calls the same core in projects.js.
import { join } from "node:path";
import { requireConfig } from "../config.js";
import { runBackup } from "./backup.js";
import { detectApp, dirStats, fileCandidates, findApps, formatBytes, suggestName } from "../detect.js";
import { readDatabaseSettings } from "../envfile.js";
import { backupUserSql, generatePassword, routinesWarning } from "../mysql.js";
import { paths } from "../paths.js";
import { discardDatabase, prepareDatabase, saveProject, validateAppDir, validateFolders, validateName } from "../projects.js";
import { UserError, bold, dim, info, ok, red, warn, yellow } from "../ui.js";

export class Cancelled extends Error {}

export async function addFlow(ask, { p = paths(), dir } = {}) {
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

    info(`\n${bold(name)}  ${dim(dir)}`);
    info(`  Database  ${db.settings.database} @ ${db.settings.socket ?? `${db.settings.host}:${db.settings.port}`} as ${db.settings.username}`);
    info(`  Files     ${files.length ? files.join(", ") : dim("none (database only)")}`);
    if (!(await ask.confirm({ message: `Add ${name}?`, default: true }))) throw new Cancelled();

    await saveProject({ name, dir, framework: app.framework, db: db.settings, source: db.source, files }, p);
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
    const input = await ask.input({ message: "App directory", default: "/var/www/", required: true });
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
  info(`
${yellow("⚠")} ${bold("Agouti needs this app's database connection details.")}

They're in ${bold(envFile)}. That file usually also holds the app's most
sensitive secrets: APP_KEY (decrypts sessions and encrypted data), mail and
payment API keys, cloud credentials.

${bold("If you allow it, Agouti will:")}
  • read .env once, now, and never again
  • keep only the DB_* lines (connection, host, port, database, username,
    password); every other line is discarded immediately, never stored,
    logged or sent anywhere
  • save the database password in ${join(p.projectsDir, `${name}.cnf`)},
    readable by root only, and pass it to MySQL through that file, never on
    the command line

${bold("How serious is this?")} ${yellow("Moderate.")}
  Agouti runs as root, and root can already read .env, so this doesn't open
  a new way in. But the app's database user can usually change and delete data,
  and a copy of its password would now live in a second place on this server.

${bold("What we suggest:")} a dedicated ${bold("read-only backup user")}.
  Backups are exactly the same, but if that password ever leaks, it can't be
  used to change or delete your data, and changing the app's own password
  later won't break your backups. Agouti gives you the SQL to create it.
`);
}

async function askDatabase(ask, { app, name, p }) {
  if (app.envFile) explainEnvAccess(app.envFile, name, p);
  else info(`\n${bold("Database")}: Agouti needs the connection details for this app's MySQL/MariaDB database.`);

  for (;;) {
    const method = await ask.select({
      message: "How should Agouti connect to the database?",
      choices: [
        { value: "backup-user", name: "Create a read-only backup user (recommended)", description: "Agouti shows the SQL; you run it as a MySQL admin." },
        ...(app.envFile
          ? [{ value: "env", name: "Read the details from .env", description: "Uses the app's own database user. Only DB_* lines are kept." }]
          : []),
        { value: "manual", name: "Enter the details of an existing database user" },
        { value: "cancel", name: "Cancel" },
      ],
    });
    if (method === "cancel") throw new Cancelled();

    let settings;
    try {
      if (method === "backup-user") settings = await backupUserSetup(ask);
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

async function backupUserSetup(ask) {
  const database = (await ask.input({ message: "Database name (the app's DB_DATABASE)", required: true })).trim();
  const password = generatePassword();
  info(`
Run this as a MySQL admin (on most servers: ${bold("sudo mysql")}):

${backupUserSql({ database, password })}

${dim("It can read the database (all mysqldump needs) but can't change anything.")}
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
  return { host: "localhost", port: 3306, database, username: "agouti_backup", password };
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
      warn(`${check.message} Install it (e.g. \`apt install mysql-client\`) before the first backup.`);
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
      const s = c.include ? await dirStats(join(dir, c.path)) : null;
      const detail = s ? `${formatBytes(s.bytes)} · ${s.files.toLocaleString("en-US")} ${s.files === 1 ? "file" : "files"}` : `(${c.reason})`;
      choices.push({ value: c.path, name: `${c.path.padEnd(22)} ${dim(detail)}${c.note ? dim(` · ${c.note}`) : ""}`, checked: c.include });
    }
    chosen = await ask.checkbox({ message: "Which folders hold uploaded files to back up?", choices });
  }
  for (;;) {
    const extra = await ask.input({
      message: candidates.length
        ? "Other folders to include (comma-separated, optional)"
        : "Folders with uploaded files (comma-separated, relative to the app; empty for none)",
    });
    try {
      const folders = await validateFolders(dir, [...chosen, ...extra.split(",")]);
      if (!folders.length) warn("No folders selected: only the database will be backed up.");
      return folders;
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      info(`${red("✕")} ${err.message}`);
    }
  }
}
