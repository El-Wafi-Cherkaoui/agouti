// Automatic backups, interactively ("Automatic backups" in the app, or
// `sudo agouti schedule` in a terminal). `agouti schedule --daily ...` uses the
// same pieces without questions.
import { requireConfig } from "../config.js";
import { loadHealthcheck, ping, saveHealthcheck, validateHealthcheckUrl } from "../healthcheck.js";
import { paths } from "../paths.js";
import { DEFAULT_RETENTION } from "../retention.js";
import { SERVICE, TASK, TIMER, agoutiCommand, installSchedule, parseTime, removeSchedule, scheduleStatus, serverTimezone, taskLog } from "../schedule.js";
import { isWindows } from "../platform.js";
import { UserError, bold, dim, green, info, ok, red, warn, yellow } from "../ui.js";
import { explainVerify, setupVerifyFlow } from "./verify.js";
import { loadAlerts } from "../alerts.js";
import { addChannel } from "./alerts.js";

export async function scheduleFlow(ask, { p = paths() } = {}) {
  const config = await requireConfig(p);
  const status = await scheduleStatus(config);
  if (!status.enabled) return setupSchedule(ask, config, p);

  const url = await loadHealthcheck(p);
  info("");
  printStatus(status, url, config);
  const action = await ask.select({
    message: "What do you want to change?",
    choices: [
      ...(status.problem ? [{ value: "repair", name: isWindows() ? "Repair the scheduled task" : "Repair the timer", description: "Reinstall it with the Node and Agouti running now." }] : []),
      { value: "time", name: "Change the time" },
      { value: "healthcheck", name: url ? "Change the healthcheck" : "Add a healthcheck (recommended)" },
      ...(url ? [{ value: "no-healthcheck", name: "Remove the healthcheck" }] : []),
      { value: "off", name: "Turn off automatic backups" },
      { value: "back", name: "Back" },
    ],
  });
  if (action === "repair") printInstalled(await installSchedule(config, status.time, { p }), url);
  if (action === "time") printInstalled(await installSchedule(config, await askTime(ask, status.time), { p }), url);
  if (action === "healthcheck") await askHealthcheck(ask, p, { skippable: false });
  if (action === "no-healthcheck") {
    await saveHealthcheck(null, p);
    warn("Healthcheck removed. If backups stop, nothing will tell you.");
  }
  if (action === "off") {
    if (!(await ask.confirm({ message: "Turn off automatic backups? Existing restore points are kept.", default: false }))) return;
    await removeSchedule(config, { p });
    warn("Automatic backups are off. Backups now only happen when someone starts them.");
  }
}

async function setupSchedule(ask, config, p) {
  const policy = config.retention ?? DEFAULT_RETENTION;
  info(`
${bold("Automatic backups")}
Every day, Agouti will:
  1. Back up every app (database + files) as a new restore point.
  2. Delete restore points you no longer need. It keeps the last ${policy.daily} days,
     ${policy.weekly} weeks and ${policy.monthly} months (change this in agouti.yml).
  3. Ping your healthcheck, if you set one up (next step).
${isWindows() ? `It runs as a Task Scheduler task ("${TASK}") on this server.` : `It runs as a systemd timer (${TIMER}) on this server.`}
`);
  const time = await askTime(ask, "03:00");
  let url = await loadHealthcheck(p);
  if (!url) url = await askHealthcheck(ask, p);
  if (!(await loadAlerts(p)).length) {
    if (await ask.confirm({ message: "Also get a message (Discord, Slack, Telegram, ntfy) saying what failed?", default: true })) await addChannel(ask, { p });
  }
  if (!config.verify) {
    explainVerify();
    if (await ask.confirm({ message: "Set up weekly restore tests? (recommended)", default: true })) {
      try {
        await setupVerifyFlow(ask, { p, explained: true });
        Object.assign(config, { verify: (await requireConfig(p)).verify });
      } catch (err) {
        if (!(err instanceof UserError)) throw err;
        warn(`Restore tests not set up: ${err.message}`);
      }
    } else warn("No restore tests: you won't know if backups can't be restored until you need one.");
  }
  config.retention ??= { ...DEFAULT_RETENTION };
  printInstalled(await installSchedule(config, time, { p }), url);
}

async function askTime(ask, current) {
  const time = await ask.input({
    message: `Back up every day at (24h, server time: ${serverTimezone()})`,
    default: current,
    validate: (v) => {
      try {
        parseTime(v);
        return true;
      } catch (err) {
        return err.hint;
      }
    },
  });
  return parseTime(time);
}

// Explains, asks for a ping URL, sends a test ping and saves it. Returns the URL or null.
export async function askHealthcheck(ask, p, { skippable = true } = {}) {
  info(`
${bold("Healthcheck")}
A timer can't tell you when it stops running: the server is off, the disk is full,
a storage key expired... A healthcheck can. After every scheduled backup Agouti
pings it, and it alerts you (email, Slack, Telegram...) when a backup ${bold("fails")}
or when no ping arrives at all.

Free at ${bold("https://healthchecks.io")} (or self-hosted). Create a check with
period ${bold("1 day")} and grace ${bold("1 hour")}, then copy its ping URL.
`);
  for (;;) {
    if (skippable) {
      const choice = await ask.select({
        message: "Set up a healthcheck?",
        choices: [
          { value: "yes", name: "Paste a ping URL (recommended)" },
          { value: "skip", name: "Skip for now", description: "You can add one later from the app or with `agouti schedule --healthcheck <url>`." },
        ],
      });
      if (choice === "skip") {
        warn("No healthcheck: if backups stop, nothing will tell you.");
        return null;
      }
    }
    const url = validateHealthcheckUrl(
      await ask.input({
        message: "Ping URL",
        validate: (v) => {
          try {
            validateHealthcheckUrl(v);
            return true;
          } catch (err) {
            return err.message;
          }
        },
      }),
    );
    info(dim("Sending a test ping..."));
    const sent = await ping(url, "success", "Test ping from `agouti schedule`.");
    if (sent.ok) {
      await saveHealthcheck(url, p);
      ok("Test ping sent: the check should now show as up.");
      return url;
    }
    info(`${red("✕")} The test ping failed: ${sent.error}`);
    const next = await ask.select({
      message: "What now?",
      choices: [
        { value: "retry", name: "Enter the URL again" },
        { value: "save", name: "Save it anyway", description: "E.g. if this server can't reach it yet." },
        ...(skippable ? [{ value: "skip", name: "Skip for now" }] : [{ value: "skip", name: "Cancel" }]),
      ],
    });
    if (next === "save") {
      await saveHealthcheck(url, p);
      return url;
    }
    if (next === "skip") return null;
  }
}

export function printInstalled(status, url) {
  ok(`Daily backups at ${bold(status.time)} ${dim(`(${serverTimezone()})`)}${status.nextRun ? dim(` · next: ${status.nextRun}`) : ""}`);
  if (status.problem) warn(status.problem);
  if (url) ok(`Healthcheck: ${maskUrl(url)}. You'll be alerted if a backup fails or doesn't run.`);
  else warn(`No healthcheck. Add one later: ${bold("sudo agouti schedule --healthcheck <url>")}`);
  const [node] = agoutiCommand();
  if (/\/\.nvm\/|^\/home\/|\\nvm\\|\\AppData\\/i.test(node)) {
    info(dim(`The ${isWindows() ? "task" : "timer"} runs ${node}. If you remove that Node version, run \`sudo agouti schedule\` again to update it.`));
  }
  info(dim(isWindows() ? `Output of the last run: type "${taskLog()}"` : `Logs: journalctl -u ${SERVICE.replace(".service", "")}`));
}

export function printStatus(status, url, config) {
  if (!status.enabled) {
    info(`${yellow("⚠")} Automatic backups are ${bold("off")}: backups only happen when someone starts them.`);
    return;
  }
  const policy = config.retention ?? DEFAULT_RETENTION;
  info(`${status.problem ? red("✕") : green("✓")} Daily backups at ${bold(status.time)} ${dim(`(${serverTimezone()})`)}`);
  if (status.problem) info(`  ${red(status.problem)}`);
  else if (status.nextRun) info(dim(`  next: ${status.nextRun}`));
  info(dim(`  keeps ${policy.daily} daily, ${policy.weekly} weekly, ${policy.monthly} monthly restore points`));
  info(config.verify ? dim("  restore test: weekly") : `  ${yellow("⚠")} no restore tests: set them up with "Test a restore"`);
  info(url ? dim(`  healthcheck: ${maskUrl(url)}`) : `  ${yellow("⚠")} no healthcheck: if backups stop, nothing will tell you`);
}

// The ping URL is a secret (anyone with it can send fake "all good" pings).
export function maskUrl(url) {
  const u = new URL(url);
  const path = u.pathname.length > 9 ? `${u.pathname.slice(0, 7)}…` : u.pathname;
  return `${u.host}${path}`;
}
