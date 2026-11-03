import { CHANNELS, loadAlerts, saveAlert, sendAlert, telegramChat, testMessage } from "../alerts.js";
import { requireConfig } from "../config.js";
import { alertsFlow, printChannels } from "../flows/alerts.js";
import { paths } from "../paths.js";
import { defaultAsk } from "../prompts.js";
import { UserError, info, ok, red, warn } from "../ui.js";

export const usage = `Usage: agouti alerts                       Set up alert channels (interactive)
       agouti alerts --add <channel> --to <value>
       agouti alerts --remove <channel>
       agouti alerts --test | --list

When a scheduled backup has a problem, get a message saying what went wrong and
what to do, and another when things work again. (Missed runs: that's what the
healthcheck is for. Email: use your healthcheck's email alerts.)

Channels:
  discord    --to <webhook URL>
  slack      --to <webhook URL>
  telegram   --to "<bot token> <chat id>", or just the token after sending the
             bot a message (Agouti finds the chat)
  ntfy       --to <topic URL>, e.g. https://ntfy.sh/<long-random-topic>
  webhook    --to <URL> (JSON POST)

Adding a channel sends a test alert.`;

export const options = {
  add: { type: "string" },
  to: { type: "string" },
  remove: { type: "string" },
  test: { type: "boolean" },
  list: { type: "boolean" },
};

export async function alerts({ values }, { ask = defaultAsk, p = paths(), tty = process.stdin.isTTY && process.stdout.isTTY } = {}) {
  await requireConfig(p);
  const kind = values.add ?? values.remove;
  if (kind && !CHANNELS[kind]) throw new UserError(`Unknown channel: ${kind}`, `Channels: ${Object.keys(CHANNELS).join(", ")}`);

  if (values.remove) {
    await saveAlert(values.remove, null, p);
    return ok(`${CHANNELS[values.remove].name} removed.`);
  }
  if (values.add) {
    if (!values.to) throw new UserError(`--add ${values.add} needs --to <value>.`, usage);
    let target = values.to.trim();
    if (values.add === "telegram" && !target.includes(" ")) {
      const chat = await telegramChat(target);
      if (!chat) throw new UserError("No chat found: send any message to the bot first, then run this again.");
      target = `${target} ${chat.id}`;
    }
    await saveAlert(values.add, target, p); // validates
    const [sent] = await sendAlert([{ kind: values.add, target }], testMessage());
    if (sent.ok) return ok(`${CHANNELS[values.add].name} added. Test alert sent: check it arrived.`);
    process.exitCode = 1;
    return warn(`${CHANNELS[values.add].name} saved, but the test alert failed: ${sent.error}`);
  }
  if (values.test) {
    const channels = await loadAlerts(p);
    if (!channels.length) throw new UserError("No alert channels yet.", "Add one: sudo agouti alerts");
    for (const r of await sendAlert(channels, testMessage())) {
      if (r.ok) ok(`Sent to ${CHANNELS[r.kind].name}.`);
      else {
        process.exitCode = 1;
        info(`${red("✕")} ${CHANNELS[r.kind].name}: ${r.error}`);
      }
    }
    return;
  }
  if (values.list || !tty) return printChannels(await loadAlerts(p));
  await alertsFlow(ask, { p });
}
