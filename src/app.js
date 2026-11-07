// The interactive app: what `sudo agouti` opens. Guided setup on a fresh server,
// then a home screen with every action. Each action calls the same core code as
// the matching command, so `agouti <command>` and this app always behave the same.
import { readFile } from "node:fs/promises";
import { printCreated } from "./commands/init.js";
import { addFlow } from "./flows/add.js";
import { runBackup } from "./flows/backup.js";
import { offerBringBack } from "./flows/adopt.js";
import { alertsFlow } from "./flows/alerts.js";
import { protectFlow, protectionLabel } from "./flows/protect.js";
import { protectionKind } from "./protection.js";
import { restoreFlow, runRestore } from "./flows/restore.js";
import { replaceText } from "./backup.js";
import { verifyFlow, verifyLabel } from "./flows/verify.js";
import { printStatus, scheduleFlow } from "./flows/schedule.js";
import { loadConfig } from "./config.js";
import { loadHealthcheck } from "./healthcheck.js";
import { paths } from "./paths.js";
import { askRecoveryKey, askStorage, defaultAsk } from "./prompts.js";
import { normalizeRecoveryKey } from "./recovery-key.js";
import { connectRepository, createRepository, repositoryStatus } from "./repository.js";
import { acceptChange, flaggedChanges, loadState, recordReplace } from "./state.js";
import { scheduleStatus } from "./schedule.js";
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
  if (!(await ask.confirm({ message: "Add your first app now?", default: true }))) return;
  await addFlow(ask, { p });
  // Last step of the setup: without a schedule, backups only happen when someone remembers.
  if (!Object.keys((await loadConfig(p))?.projects ?? {}).length) return;
  if (await ask.confirm({ message: "Turn on daily automatic backups now?", default: true })) await scheduleFlow(ask, { p });
  else warn("Automatic backups are off. Turn them on from the home screen when you're ready.");
}

async function connectFlow(ask, p) {
  info(dim("Describe where the existing repository is stored.\n"));
  const { repository, env: credentials } = await askStorage(ask);
  const key = normalizeRecoveryKey(await askRecoveryKey(ask));
  info(dim("\nChecking the repository..."));
  await connectRepository({ repository, credentials, key }, { p, log: info });
  ok(`Connected to ${bold(describeRepository(repository))}`);
  await offerBringBack(ask, { p });
}

async function home(config, ask, p) {
  const apps = Object.entries(config.projects ?? {});
  const state = await loadState(p);
  info(
    `\n${bold("agouti")} · ${apps.length} ${apps.length === 1 ? "app" : "apps"} · repo: ${describeRepository(config.repository)}${protectionLabel(config) ? ` · ${protectionLabel(config)}` : ""}`,
  );
  if (apps.length === 0) info(dim("No apps yet. Add your first one to start backing up."));
  else info(dim(`  ${"APP".padEnd(14)}${"LAST BACKUP".padEnd(LABEL)}RESTORE TEST`));
  for (const [name] of apps) {
    const s = state.projects[name];
    info(`  ${bold(name.padEnd(14))}${padVisible(lastBackupLabel(s), LABEL)}${verifyLabel(s?.lastVerify, Boolean(config.verify))}`);
  }
  // First: an unfinished replace means live data may be half there.
  const unfinished = apps.filter(([name]) => state.projects[name]?.replacing).map(([name]) => ({ app: name, ...state.projects[name].replacing }));
  for (const u of unfinished) info(`\n${red("⚠")} ${bold(u.app)}: ${replaceText(u)}. The live ${u.parts.join(" and ")} may be incomplete.`);
  const flagged = flaggedChanges(state).filter((f) => config.projects?.[f.app]);
  for (const f of flagged) info(`\n${yellow("⚠")} ${bold(f.app)}: ${changeSummary(f)}`);
  const schedule = await scheduleStatus(config);
  if (apps.length) {
    info("");
    printStatus(schedule, await loadHealthcheck(p), config);
  }
  info("");
  const acceptChoice = {
    value: "accept",
    name: "Accept a change in the data",
    description: "The data shrank on purpose (deleted, archived): make it the new normal.",
  };

  const backupChoice = { value: "backup", name: "Back up now", description: "Database and files, as one restore point." };
  const addChoice = { value: "add", name: "Add an app", description: "Back up another app's database and uploaded files." };
  const scheduleChoice = {
    value: "schedule",
    name: schedule.enabled ? "Automatic backups" : "Turn on automatic backups",
    description: schedule.enabled
      ? "Change the time or the healthcheck, or turn them off."
      : "Back up every app daily, delete old restore points, alert on failure.",
  };
  const action = await ask.select({
    message: "What do you want to do?",
    pageSize: 12,
    choices: [
      // The most likely next step first. Nothing disabled, so the cursor never lands on it.
      ...(unfinished.length
        ? [{ value: "unfinished", name: "Repair the interrupted replace", description: "Put back the state from before, or run the replace again." }]
        : []),
      ...(apps.length
        ? schedule.enabled && !schedule.problem
          ? [backupChoice, addChoice, scheduleChoice]
          : [backupChoice, scheduleChoice, addChoice]
        : [addChoice]),
      ...(flagged.length ? [acceptChoice] : []),
      {
        value: "restore",
        name: "Restore",
        description: apps.length ? "A database, files or a single file, as a copy or in place." : "Bring back apps from the backups (e.g. on a new server).",
      },
      ...(apps.length
        ? [
            {
              value: "verify",
              name: "Test a restore",
              description: config.verify
                ? "Restore the latest backups for real, check them, delete them again."
                : "Prove backups can be restored. Set up once, then weekly.",
            },
          ]
        : []),
      ...(config.protection || !protectionKind(config.repository)
        ? []
        : [
            {
              value: "protect",
              name: "Protect backups from deletion",
              description: "Make the storage append-only, so an attacker on this server can't delete backups.",
            },
          ]),
      ...(apps.length ? [{ value: "alerts", name: "Alerts", description: "Get a message on Discord, Slack, Telegram or ntfy when something fails." }] : []),
      { value: "check", name: "Check storage", description: "Make sure this server can still reach the repository." },
      { value: "key", name: "Show recovery key", description: "In case you didn't save it during setup." },
      { value: "quit", name: "Quit" },
    ],
  });

  try {
    if (action === "quit") return "quit";
    if (action === "backup") await backupNow(ask, apps, p);
    if (action === "add") await addFlow(ask, { p });
    if (action === "schedule") await scheduleFlow(ask, { p });
    if (action === "restore") await restoreFlow(ask, { p });
    if (action === "verify") await verifyFlow(ask, { p });
    if (action === "protect") await protectFlow(ask, { p });
    if (action === "alerts") await alertsFlow(ask, { p });
    if (action === "check") await checkStorage(config, p);
    if (action === "key") await showKey(ask, p);
    if (action === "accept") await acceptFlow(ask, flagged, p);
    if (action === "unfinished") await unfinishedFlow(ask, unfinished, p);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    showError(err);
  }
}

// One line per flagged app for the home screen.
export function changeSummary(f) {
  const since = (f.shrunk?.since ?? f.verify?.at ?? "").replace("T", " ").slice(0, 16);
  const what = [f.shrunk && "its backups shrank sharply", f.verify && "the restore test says the backup looks wrong"].filter(Boolean).join(", and ");
  return `${what}${since ? ` (since ${since} UTC)` : ""}. Older restore points are kept until this is resolved.`;
}

async function unfinishedFlow(ask, unfinished, p) {
  const u = unfinished.length === 1 ? unfinished[0] : await ask.select({ message: "Which app?", choices: unfinished.map((x) => ({ value: x, name: x.app })) });
  const t = (iso) => `${iso.replace("T", " ").slice(0, 16)} UTC`;
  const what = u.parts.join(" and ");
  const choice = await ask.select({
    message: `${u.app}: ${replaceText(u)}. What now?`,
    choices: [
      ...(u.safety
        ? [{ value: "back", name: `Put back the state from before (${t(u.at)})`, description: `Undo: the ${what} as they were just before the replace.` }]
        : []),
      { value: "again", name: `Run the replace again (backup of ${t(u.pointAt)})`, description: `Finish what was started: the ${what} as in that backup.` },
      { value: "fine", name: "It's been fixed another way", description: "Only removes this warning. Nothing is restored." },
      { value: "cancel", name: "Back" },
    ],
  });
  if (choice === "cancel") return;
  if (choice === "fine") {
    if (!(await ask.confirm({ message: `Is ${u.app}'s live data complete again?`, default: false }))) return;
    await recordReplace(u.app, null, p);
    return ok("Warning removed.");
  }
  const point = choice === "back" ? u.safety : u.point;
  if (!(await ask.confirm({ message: `Replace ${u.app}'s live ${what} with ${choice === "back" ? "the state from before" : "that backup"}?`, default: true }))) return;
  await runRestore({ app: u.app, point, parts: u.parts, mode: "replace" }, { p });
}

async function acceptFlow(ask, flagged, p) {
  const f =
    flagged.length === 1
      ? flagged[0]
      : await ask.select({ message: "Which app?", choices: flagged.map((x) => ({ value: x, name: x.app })) });
  info("");
  if (f.shrunk) info(`  ${f.shrunk.text}`);
  for (const pr of f.verify?.problems ?? []) info(`  ${pr}`);
  info(dim(`\nIf this data was lost by accident or an attack, don't accept: restore it from an older point (Restore).`));
  const yes = await ask.confirm({ message: `Was this data removed from ${f.app} on purpose?`, default: false });
  if (!yes) return info(dim("Nothing changed. The warning stays until the data is back or you accept it."));
  await acceptChange(f.app, p);
  ok(`Accepted: ${f.app}'s current data is the new normal. Old restore points will be deleted as usual again.`);
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

const LABEL = 30;
// Pads to a visible width, ignoring colour codes.
const padVisible = (text, width) => text + " ".repeat(Math.max(1, width - text.replace(/\x1b\[[0-9;]*m/g, "").length));

export function lastBackupLabel(s) {
  const last = s?.lastBackup;
  if (!last) return dim("never backed up");
  if (last.ok && last.shrunk) return `${yellow("⚠")} ${ago(last.at)} ${dim("(data shrank)")}`;
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
