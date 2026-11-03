// Direct alerts: a message on Discord, Slack, Telegram, ntfy or any webhook when
// a scheduled run has a problem, saying what went wrong and what to do; and one
// when things work again. (Missed runs are the healthcheck's job: a server that's
// off can't send anything.)
//
// Webhook URLs and bot tokens let anyone post to your channel, so they're kept in
// credentials.env (root-only), like the healthcheck URL.
import { hostname } from "node:os";
import { loadCredentials, saveCredentials } from "./config.js";
import { paths } from "./paths.js";
import { UserError } from "./ui.js";

const https = (v, hosts) => {
  let u;
  try {
    u = new URL(String(v).trim());
  } catch {
    return "Paste the full URL, starting with https://";
  }
  if (u.protocol !== "https:") return "The URL must start with https://";
  if (hosts && !hosts.some((h) => u.host === h || u.host.endsWith(`.${h}`))) return `That isn't a ${hosts[0]} URL.`;
  return true;
};

export const CHANNELS = {
  discord: {
    name: "Discord",
    key: "AGOUTI_ALERT_DISCORD",
    ask: "Webhook URL",
    help: "In Discord: Server Settings → Integrations → Webhooks → New Webhook, pick the channel, Copy Webhook URL.",
    validate: (v) => https(v, ["discord.com", "discordapp.com"]),
  },
  slack: {
    name: "Slack",
    key: "AGOUTI_ALERT_SLACK",
    ask: "Webhook URL",
    help: "In Slack: create an app (api.slack.com/apps) → Incoming Webhooks → on → Add New Webhook to Workspace, pick the channel, copy the URL.",
    validate: (v) => https(v, ["hooks.slack.com"]),
  },
  telegram: {
    name: "Telegram",
    key: "AGOUTI_ALERT_TELEGRAM",
    ask: "Bot token",
    help: "In Telegram: talk to @BotFather → /newbot → copy the token it gives you.",
    validate: (v) => /^\d+:[\w-]{30,}$/.test(String(v).split(" ")[0].trim()) || "A bot token looks like 123456789:AAH...",
  },
  ntfy: {
    name: "ntfy (push to your phone)",
    key: "AGOUTI_ALERT_NTFY",
    ask: "Topic URL",
    help: "Install the ntfy app, subscribe to a topic with a long, hard-to-guess name, e.g. https://ntfy.sh/agouti-7f3k92qx (anyone who knows it can read it).",
    validate: (v) => https(v),
  },
  webhook: {
    name: "Webhook (JSON)",
    key: "AGOUTI_ALERT_WEBHOOK",
    ask: "URL",
    help: 'Agouti POSTs JSON: { "source": "agouti", "event", "host", "title", "lines", "text" }.',
    validate: (v) => https(v),
  },
};

// [{ kind, target }] for the channels set up.
export async function loadAlerts(p = paths()) {
  const creds = await loadCredentials(p);
  return Object.entries(CHANNELS)
    .filter(([, c]) => creds[c.key])
    .map(([kind, c]) => ({ kind, target: creds[c.key] }));
}

export async function saveAlert(kind, target, p = paths()) {
  const c = CHANNELS[kind];
  if (!c) throw new UserError(`Unknown alert channel: ${kind}`, `Channels: ${Object.keys(CHANNELS).join(", ")}`);
  const creds = await loadCredentials(p);
  if (target) {
    const valid =
      kind === "telegram" && !/^\d+:[\w-]{30,} -?\d+$/.test(String(target).trim())
        ? 'Give the bot token and the chat id: "<token> <chat id>".'
        : c.validate(target);
    if (valid !== true) throw new UserError(valid);
    creds[c.key] = String(target).trim();
  } else delete creds[c.key];
  await saveCredentials(creds, p);
}

// What's shown when listing: enough to recognise it, not enough to use it.
export function describeTarget(kind, target) {
  if (kind === "telegram") return `chat ${target.split(" ")[1] ?? "?"}`;
  const u = new URL(target);
  return `${u.host}${u.pathname.length > 12 ? `${u.pathname.slice(0, 10)}…` : u.pathname}`;
}

// Telegram: the chat to write to is the last one that wrote to the bot.
export async function telegramChat(token, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(15000) });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new UserError(`Telegram refused the token: ${json.description ?? `HTTP ${res.status}`}`);
  const chat = json.result
    ?.map((u) => (u.message ?? u.channel_post ?? u.my_chat_member)?.chat)
    .filter(Boolean)
    .at(-1);
  return chat ? { id: String(chat.id), name: chat.title ?? chat.username ?? chat.first_name ?? String(chat.id) } : null;
}

// message: { event: "failure" | "recovered" | "test", title, lines: [] }
export function formatText({ title, lines = [] }) {
  return [title, ...lines.map((l) => (l.startsWith("  ") ? l : `• ${l}`))].join("\n");
}

function request(kind, target, message) {
  const text = formatText(message);
  const failure = message.event === "failure";
  switch (kind) {
    case "discord":
      return { url: target, json: { username: "Agouti", content: text.slice(0, 1990) } };
    case "slack":
      return { url: target, json: { text } };
    case "telegram": {
      const [token, chat] = target.split(" ");
      return { url: `https://api.telegram.org/bot${token}/sendMessage`, json: { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true } };
    }
    case "ntfy":
      return {
        url: target,
        body: message.lines.join("\n") || message.title,
        headers: {
          // Header values must be plain ASCII.
          title: message.title.replace(/[^\x20-\x7e]/g, "").trim(),
          priority: failure ? "high" : "default",
          tags: failure ? "warning" : "white_check_mark",
        },
      };
    default:
      return { url: target, json: { source: "agouti", event: message.event, host: hostname(), title: message.title, lines: message.lines, text } };
  }
}

// Sends to every channel. Never throws: an alert that can't be sent must not
// hide the problem it was about. Returns [{ kind, ok, error }].
export async function sendAlert(channels, message, { fetchImpl = fetch } = {}) {
  return Promise.all(
    channels.map(async ({ kind, target }) => {
      const r = request(kind, target, message);
      let error;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await fetchImpl(r.url, {
            method: "POST",
            headers: { ...(r.json ? { "content-type": "application/json" } : {}), "user-agent": "agouti", ...(r.headers ?? {}) },
            body: r.json ? JSON.stringify(r.json) : r.body,
            signal: AbortSignal.timeout(10000),
          });
          if (res.ok) return { kind, ok: true };
          error = `HTTP ${res.status}${await res
            .text()
            .then((t) => (t ? `: ${t.slice(0, 120)}` : ""))
            .catch(() => "")}`;
          if (res.status < 500 && res.status !== 429) break;
        } catch (err) {
          error = err.cause?.code ?? err.cause?.message ?? err.message;
        }
        if (attempt < 2) await new Promise((res) => setTimeout(res, 2000));
      }
      return { kind, ok: false, error };
    }),
  );
}

export function testMessage() {
  return {
    event: "test",
    title: `✓ Agouti on ${hostname()}: test alert`,
    lines: ["If a scheduled backup has a problem, you'll get a message here saying what and what to do."],
  };
}
