// The interactive app: what `sudo agouti` opens. Guided setup on a fresh server,
// then a home screen with every action. Each action calls the same core code as
// the matching command, so `agouti <command>` and this app always behave the same.
import { readFile } from "node:fs/promises";
import { Separator } from "@inquirer/prompts";
import { printCreated } from "./commands/init.js";
import { addFlow } from "./flows/add.js";
import { runBackup } from "./flows/backup.js";
import { loadConfig } from "./config.js";
import { paths } from "./paths.js";
import { askRecoveryKey, askStorage, defaultAsk } from "./prompts.js";
import { normalizeRecoveryKey } from "./recovery-key.js";
import { connectRepository, createRepository, repositoryStatus } from "./repository.js";
import { loadState } from "./state.js";
import { describeRepository } from "./storage.js";
import { UserError, bold, dim, green, info, ok, red, warn, yellow } from "./ui.js";

export async function app({ ask = defaultAsk, p = paths() } = {}) {
  for (;;) {
    const config = await loadConfig(p);
    const next = config?.repository ? await home(config, ask, p) : await setup(ask, p);
    if (next === "quit") return;
  }
}

async function setup(ask, p) {
  info(`\n${bold("agouti")}: backups for the apps on this server\n`);
  info("Let's set it up. First, where backups are stored; then, your apps.\n");

  const choice = await ask.select({
    message: "Is this a new setup?",
    choices: [
      { value: "create", name: "Yes, create a new backup repository", description: "First time using Agouti for this server." },
      {
        value: "connect",
        name: "No, connect to an existing repository",
        description: "Moving to a new server, or restoring after losing one. You'll need the recovery key.",
      },
      { value: "quit", name: "Quit" },
    ],
  });
  if (choice === "quit") return "quit";

  try {
    if (choice === "create") await createFlow(ask, p);
    else await connectFlow(ask, p);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    showError(err);
    const again = await ask.select({
      message: "What now?",
      choices: [
        { value: "retry", name: "Try again" },
        { value: "quit", name: "Quit" },
      ],
    });
    return again;
  }
}

async function createFlow(ask, p) {
  const { repository, env: credentials } = await askStorage(ask, { warnLocal: true });
  info(dim("\nCreating the repository..."));
  const key = await createRepository({ repository, credentials }, { p, log: info });
  printCreated(repository, key);
  while (!(await ask.confirm({ message: "Have you saved the recovery key somewhere outside this server?", default: false }))) {
    warn(`Please do. It's the only way to restore if this server is lost:\n  ${bold(key)}\n`);
  }
  ok("Storage is ready.");
  if (await ask.confirm({ message: "Add your first app now?", default: true })) await addFlow(ask, { p });
}

async function connectFlow(ask, p) {
  info(dim("Describe where the existing repository is stored.\n"));
  const { repository, env: credentials } = await askStorage(ask);
  const key = normalizeRecoveryKey(await askRecoveryKey(ask));
  info(dim("\nChecking the repository..."));
  await connectRepository({ repository, credentials, key }, { p, log: info });
  ok(`Connected to ${bold(describeRepository(repository))}`);
}

async function home(config, ask, p) {
  const apps = Object.entries(config.projects ?? {});
  const state = await loadState(p);
  info(`\n${bold("agouti")} · ${apps.length} ${apps.length === 1 ? "app" : "apps"} · repo: ${describeRepository(config.repository)}`);
  if (apps.length === 0) info(dim("No apps yet. Add your first one to start backing up."));
  else info(dim(`  ${"APP".padEnd(14)}LAST BACKUP`));
  for (const [name] of apps) info(`  ${bold(name.padEnd(14))}${lastBackupLabel(state.projects[name])}`);
  info("");

  const backupChoice = { value: "backup", name: "Back up now", description: "Database and files, as one restore point." };
  const addChoice = { value: "add", name: "Add an app", description: "Back up another app's database and uploaded files." };
  const action = await ask.select({
    message: "What do you want to do?",
    pageSize: 12,
    choices: [
      // Working actions first, so the cursor never starts on something unavailable;
      // the most likely next step first.
      ...(apps.length ? [backupChoice, addChoice] : [addChoice]),
      { value: "check", name: "Check storage", description: "Make sure this server can still reach the repository." },
      { value: "key", name: "Show recovery key", description: "In case you didn't save it during setup." },
      { value: "quit", name: "Quit" },
      new Separator(dim("── Coming soon ──")),
      { value: "restore", name: "Restore", disabled: true },
      { value: "schedule", name: "Schedule automatic backups", disabled: true },
    ],
  });

  try {
    if (action === "quit") return "quit";
    if (action === "backup") await backupNow(ask, apps, p);
    if (action === "add") await addFlow(ask, { p });
    if (action === "check") await checkStorage(config, p);
    if (action === "key") await showKey(ask, p);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    showError(err);
  }
}

async function backupNow(ask, apps, p) {
  let names = [];
  if (apps.length > 1) {
    const choice = await ask.select({
      message: "Back up which app?",
      choices: [{ value: "", name: `All ${apps.length} apps` }, ...apps.map(([name]) => ({ value: name, name }))],
    });
    if (choice) names = [choice];
  }
  await runBackup(names, { p });
}

export function lastBackupLabel(s) {
  const last = s?.lastBackup;
  if (!last) return dim("never backed up");
  if (last.ok) return `${green("✓")} ${ago(last.at)}`;
  const good = s.lastSuccess ? `last good: ${ago(s.lastSuccess.at)}` : "no successful backup yet";
  return `${red("✕")} failed ${ago(last.at)} ${dim(`(${good})`)}`;
}

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const [n, unit] = s < 3600 ? [Math.round(s / 60), "min"] : s < 86400 ? [Math.round(s / 3600), "h"] : [Math.round(s / 86400), " days"];
  return unit === " days" && n === 1 ? "yesterday" : `${n}${unit} ago`;
}

async function checkStorage(config, p) {
  info(dim("Contacting the repository..."));
  const s = await repositoryStatus(config, { p, log: info });
  if (!s.reachable) throw new UserError(`Can't reach the repository: ${s.message}`, "Check the network and the credentials in /etc/agouti/credentials.env.");
  ok(`Storage reachable · ${s.snapshots} restore ${s.snapshots === 1 ? "point" : "points"}`);
}

async function showKey(ask, p) {
  if (!(await ask.confirm({ message: "Show the recovery key on screen?", default: true }))) return;
  const key = (await readFile(p.recoveryKey, "utf8")).trim();
  info(`\n  ${bold(key)}\n  ${yellow("Store it outside this server, e.g. in a password manager.")}`);
}

function showError(err) {
  info(`${red("✕")} ${err.message}`);
  if (err.hint) info(dim(err.hint));
}
