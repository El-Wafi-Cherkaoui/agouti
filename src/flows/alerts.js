// Alert channels, interactively ("Alerts" in the app, or `sudo agouti alerts`).
import { CHANNELS, describeTarget, loadAlerts, saveAlert, sendAlert, telegramChat, testMessage } from "../alerts.js";
import { paths } from "../paths.js";
import { bold, dim, info, ok, red, warn } from "../ui.js";

export async function alertsFlow(ask, { p = paths() } = {}) {
  for (;;) {
    const channels = await loadAlerts(p);
    info("");
    printChannels(channels);
    const action = await ask.select({
      message: "Alerts",
      choices: [
        { value: "add", name: channels.length ? "Add another channel" : "Add a channel", description: "Discord, Slack, Telegram, ntfy or a webhook." },
        ...(channels.length
          ? [
              { value: "test", name: "Send a test alert" },
              { value: "remove", name: "Remove a channel" },
            ]
          : []),
        { value: "back", name: "Back" },
      ],
    });
    if (action === "back") return;
    if (action === "add") await addChannel(ask, { p });
    if (action === "test") await sendTest(channels);
    if (action === "remove") {
      const kind = await ask.select({
        message: "Remove which?",
        choices: channels.map((c) => ({ value: c.kind, name: `${CHANNELS[c.kind].name}  ${dim(describeTarget(c.kind, c.target))}` })),
      });
      await saveAlert(kind, null, p);
      ok(`${CHANNELS[kind].name} removed.`);
    }
  }
}

export function printChannels(channels) {
  if (!channels.length) {
    info(`No alert channels yet. When a scheduled backup has a problem, a message here says what and what to do.`);
    return;
  }
  info("Alerts go to:");
  for (const c of channels) info(`  ${bold(CHANNELS[c.kind].name.padEnd(26))} ${dim(describeTarget(c.kind, c.target))}`);
}

// Asks for one channel, sends a test, saves it. Returns true if saved.
export async function addChannel(ask, { p = paths() } = {}) {
  const kind = await ask.select({
    message: "Where should alerts go?",
    choices: [...Object.entries(CHANNELS).map(([value, c]) => ({ value, name: c.name })), { value: "", name: "Cancel" }],
  });
  if (!kind) return false;
  const c = CHANNELS[kind];
  info(dim(`\n${c.help}\n`));
  for (;;) {
    let target = (await ask.input({ message: c.ask, validate: c.validate })).trim();
    if (kind === "telegram") {
      target = await telegramTarget(ask, target);
      if (!target) return false;
    }
    info(dim("Sending a test alert..."));
    const [sent] = await sendAlert([{ kind, target }], testMessage());
    if (sent.ok) {
      await saveAlert(kind, target, p);
      ok(`Test alert sent to ${c.name}. Check it arrived.`);
      return true;
    }
    info(`${red("✕")} The test alert failed: ${sent.error}`);
    const next = await ask.select({
      message: "What now?",
      choices: [
        { value: "again", name: "Enter it again" },
        { value: "save", name: "Save it anyway", description: "E.g. if this server can't reach it yet." },
        { value: "cancel", name: "Cancel" },
      ],
    });
    if (next === "save") {
      await saveAlert(kind, target, p);
      return true;
    }
    if (next === "cancel") return false;
  }
}

// The chat is found by asking Telegram who last wrote to the bot.
async function telegramTarget(ask, token) {
  for (;;) {
    await ask.confirm({ message: "Now send any message to your bot in Telegram (or add it to a group and write there). Done?", default: true });
    const chat = await telegramChat(token);
    if (chat) {
      if (await ask.confirm({ message: `Send alerts to "${chat.name}"?`, default: true })) return `${token} ${chat.id}`;
    } else warn("No message found yet. Telegram can take a few seconds.");
    if (!(await ask.confirm({ message: "Try again?", default: true }))) return null;
  }
}

async function sendTest(channels) {
  for (const r of await sendAlert(channels, testMessage())) {
    if (r.ok) ok(`Sent to ${CHANNELS[r.kind].name}.`);
    else info(`${red("✕")} ${CHANNELS[r.kind].name}: ${r.error}`);
  }
}
