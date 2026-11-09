import { requireConfig } from "../config.js";
import { validateExcludes } from "../excludes.js";
import { detectApp, fileCandidates, formatBytes, suggestName } from "../detect.js";
import { readDatabaseSettings } from "../envfile.js";
import { routinesWarning } from "../mysql.js";
import { addFlow } from "../flows/add.js";
import { paths } from "../paths.js";
import { defaultAsk } from "../prompts.js";
import { discardDatabase, prepareDatabase, saveProject, validateAppDir, validateFolders, validateName } from "../projects.js";
import { validateServiceName } from "../services.js";
import { UserError, bold, info, ok, warn } from "../ui.js";

export const usage = `Usage: agouti add [<app-directory>] [options]

Add an app to back up: its MySQL/MariaDB database and uploaded files.
In a terminal, with no database options, Agouti asks everything step by step
(including whether it may read the app's .env file).

Database (non-interactive), one of:
  --read-env           Read the database settings from the app's .env (DB_* or
                       DATABASE_URL). Only those lines are kept; the password
                       is stored in a file only root
                       (Windows: Administrators) can read.
  --db-name <name>     Connect with these details instead. Also --db-host
                       (default 127.0.0.1), --db-port (3306), --db-user.
                       The password is read from AGOUTI_DB_PASSWORD.

Options:
  --name <name>        Name for the app (default: the directory name)
  --files <a,b>        Folders to back up, relative to the app, or full paths
                       for folders outside it (default: the detected upload folders)
  --service <name>     The service that runs the app (Windows service, systemd
                       unit): stopped while a restore replaces live data
  --exclude <a,b>      Leave these out of the backups: names anywhere in those
                       folders ("thumbs", "*.tmp"), or paths relative to the app
  --no-check           Save even if the database connection fails`;

export const options = {
  name: { type: "string" },
  service: { type: "string" },
  "read-env": { type: "boolean" },
  "db-name": { type: "string" },
  "db-host": { type: "string" },
  "db-port": { type: "string" },
  "db-user": { type: "string" },
  files: { type: "string" },
  exclude: { type: "string" },
  "no-check": { type: "boolean" },
};

export async function add({ values, positionals }) {
  const p = paths();
  const dir = positionals[0];
  const scripted = values["read-env"] || values["db-name"];

  if (!scripted) {
    if (!process.stdin.isTTY) {
      throw new UserError("Not running in a terminal, so I can't ask questions.", "Pass --read-env or --db-name (see `agouti add --help`).");
    }
    await addFlow(defaultAsk, { p, dir });
    return;
  }
  if (values["read-env"] && values["db-name"]) throw new UserError("Use either --read-env or --db-name, not both.");
  if (!dir) throw new UserError("Which app directory?", usage);

  const config = await requireConfig(p);
  const appDir = await validateAppDir(dir, config);
  const app = await detectApp(appDir);
  const name = values.name ?? suggestName(appDir);
  const valid = validateName(name, config);
  if (valid !== true) throw new UserError(valid);

  let db;
  if (values["read-env"]) {
    if (!app.envFile) throw new UserError(`There's no .env file in ${appDir}.`);
    db = await readDatabaseSettings(app.envFile);
  } else {
    if (!values["db-user"]) throw new UserError("--db-user is required with --db-name.");
    db = {
      host: values["db-host"] ?? "127.0.0.1",
      port: Number(values["db-port"] ?? 3306),
      database: values["db-name"],
      username: values["db-user"],
      password: process.env.AGOUTI_DB_PASSWORD ?? "",
    };
    if (!process.env.AGOUTI_DB_PASSWORD) warn("AGOUTI_DB_PASSWORD isn't set: connecting without a password.");
  }

  const files = values.files
    ? await validateFolders(appDir, values.files.split(","))
    : (await fileCandidates(appDir, app.framework)).filter((c) => c.include).map((c) => c.path);
  const exclude = validateExcludes((values.exclude ?? "").split(","), files);
  const service = values.service?.trim() || undefined;
  if (service && validateServiceName(service) !== true) throw new UserError(`--service: "${service}" isn't a service name.`);

  try {
    const { check } = await prepareDatabase(name, db, p);
    if (check.ok) {
      ok(`Connected: ${check.version} · ${db.database} · ${check.tables} tables · ${formatBytes(check.bytes)}`);
      if (!check.routinesVisible) warn(routinesWarning(db.username));
    } else if (check.clientMissing) warn(check.message);
    else if (values["no-check"]) warn(`Couldn't connect: ${check.message} (saved anyway, --no-check)`);
    else throw new UserError(`Couldn't connect to the database: ${check.message}`, "Fix the details, or pass --no-check to save anyway.");

    await saveProject({ name, dir: appDir, framework: app.framework, db, source: values["read-env"] ? "env" : "manual", files, exclude, service }, p);
  } catch (err) {
    await discardDatabase(name, p);
    throw err;
  }
  ok(`Added ${bold(name)} (${app.label})`);
  info(`  Files: ${files.length ? files.join(", ") : "none (database only)"}`);
  if (exclude.length) info(`  Left out: ${exclude.join(", ")}`);
  if (service) info(`  Service: ${service} (stopped while a restore replaces live data)`);
}
