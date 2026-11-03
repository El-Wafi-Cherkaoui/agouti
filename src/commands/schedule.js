import { requireConfig } from "../config.js";
import { printInstalled, printStatus, scheduleFlow } from "../flows/schedule.js";
import { loadHealthcheck, ping, saveHealthcheck } from "../healthcheck.js";
import { paths } from "../paths.js";
import { defaultAsk } from "../prompts.js";
import { DEFAULT_RETENTION } from "../retention.js";
import { installSchedule, removeSchedule, scheduleStatus, scheduledTime } from "../schedule.js";
import { UserError, info, warn } from "../ui.js";

export const usage = `Usage: agouti schedule [--daily HH:MM] [--healthcheck <url> | --no-healthcheck]
       agouti schedule --off

Back up every app automatically, every day (a systemd timer). Each run also
deletes restore points no longer needed and pings the healthcheck, if set.

With no options: asks, in a terminal; otherwise shows the current schedule.

Options:
  --daily HH:MM         Time of the daily backup (24h, server time)
  --healthcheck <url>   Ping URL of a healthchecks.io-compatible check: alerts
                        you when a backup fails or doesn't run
  --no-healthcheck      Stop pinging the healthcheck
  --off                 Turn off automatic backups (restore points are kept)

Examples:
  sudo agouti schedule --daily 03:00 --healthcheck https://hc-ping.com/<uuid>
  journalctl -u agouti-backup       # logs of the scheduled runs`;

export const options = {
  daily: { type: "string" },
  healthcheck: { type: "string" },
  "no-healthcheck": { type: "boolean" },
  off: { type: "boolean" },
};

export async function schedule({ values }, { ask = defaultAsk, p = paths(), tty = process.stdin.isTTY && process.stdout.isTTY } = {}) {
  const config = await requireConfig(p);
  const flags = values.daily || values.healthcheck || values["no-healthcheck"] || values.off;
  if (!flags) {
    if (tty) return scheduleFlow(ask, { p });
    return printStatus(await scheduleStatus(config), await loadHealthcheck(p), config);
  }
  if (values.off && (values.daily || values.healthcheck)) throw new UserError("--off can't be combined with --daily or --healthcheck.");
  if (values.healthcheck && values["no-healthcheck"]) throw new UserError("Use either --healthcheck or --no-healthcheck.");

  if (values.off) {
    await removeSchedule(config, { p });
    return warn("Automatic backups are off. Existing restore points are kept.");
  }
  if (values["no-healthcheck"]) await saveHealthcheck(null, p);
  if (values.healthcheck) {
    await saveHealthcheck(values.healthcheck, p); // validates
    const sent = await ping(await loadHealthcheck(p), "success", "Test ping from `agouti schedule`.");
    if (!sent.ok) warn(`Saved, but the test ping failed: ${sent.error}. Check the URL.`);
  }
  const time = values.daily ?? scheduledTime(config);
  if (!time) {
    if (values.healthcheck || values["no-healthcheck"]) return info("Healthcheck saved. Turn on automatic backups with --daily HH:MM.");
    throw new UserError("Missing --daily HH:MM.");
  }
  config.retention ??= { ...DEFAULT_RETENTION };
  printInstalled(await installSchedule(config, time, { p }), await loadHealthcheck(p));
}
