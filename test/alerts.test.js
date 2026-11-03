// Alert channels: the request each service expects, retries, validation, and
// secrets kept out of listings. No real service is called.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHANNELS, describeTarget, formatText, loadAlerts, saveAlert, sendAlert, telegramChat } from "../src/alerts.js";
import { loadCredentials, saveConfig } from "../src/config.js";
import { addChannel } from "../src/flows/alerts.js";
import { paths } from "../src/paths.js";
import { captured, scripted } from "./helpers.js";

const message = {
  event: "failure",
  title: "✕ Agouti on vps-1: a problem with tonight's backup",
  lines: ["shop: the database wasn't backed up: Access denied for user 'agouti_backup'@'localhost'", "  Has the password of agouti_backup changed?"],
};

// Records what would be sent; answers with the given statuses in turn.
function recorder(...statuses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return new Response("", { status: statuses.shift() ?? 200 });
  };
  return { calls, fetchImpl };
}

test("each channel gets the request its service expects", async () => {
  const { calls, fetchImpl } = recorder();
  const results = await sendAlert(
    [
      { kind: "discord", target: "https://discord.com/api/webhooks/1/abc" },
      { kind: "slack", target: "https://hooks.slack.com/services/T/B/x" },
      { kind: "telegram", target: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA -1001" },
      { kind: "ntfy", target: "https://ntfy.sh/agouti-7f3k" },
      { kind: "webhook", target: "https://example.com/hook" },
    ],
    message,
    { fetchImpl },
  );
  assert.ok(results.every((r) => r.ok));
  const text = formatText(message);
  assert.equal(
    text,
    "✕ Agouti on vps-1: a problem with tonight's backup\n• shop: the database wasn't backed up: Access denied for user 'agouti_backup'@'localhost'\n  Has the password of agouti_backup changed?",
  );

  const [discord, slack, telegram, ntfy, webhook] = calls;
  assert.deepEqual(JSON.parse(discord.body), { username: "Agouti", content: text });
  assert.deepEqual(JSON.parse(slack.body), { text });
  assert.equal(telegram.url, "https://api.telegram.org/bot123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage");
  assert.deepEqual(JSON.parse(telegram.body), { chat_id: "-1001", text, disable_web_page_preview: true });
  assert.equal(ntfy.url, "https://ntfy.sh/agouti-7f3k");
  assert.equal(ntfy.headers.title, "Agouti on vps-1: a problem with tonight's backup", "HTTP headers: ASCII only");
  assert.equal(ntfy.headers.priority, "high");
  assert.equal(ntfy.body, message.lines.join("\n"));
  const hook = JSON.parse(webhook.body);
  assert.equal(hook.source, "agouti");
  assert.equal(hook.event, "failure");
  assert.deepEqual(hook.lines, message.lines);

  // Discord refuses messages over 2,000 characters.
  const long = recorder();
  await sendAlert(
    [{ kind: "discord", target: "https://discord.com/api/webhooks/1/abc" }],
    { ...message, lines: ["x".repeat(5000)] },
    { fetchImpl: long.fetchImpl },
  );
  assert.ok(JSON.parse(long.calls[0].body).content.length <= 2000);
});

test("a server hiccup is retried; a wrong URL isn't; nothing throws", async () => {
  const flaky = recorder(502, 200);
  const [r] = await sendAlert([{ kind: "slack", target: "https://hooks.slack.com/services/T/B/x" }], message, { fetchImpl: flaky.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(flaky.calls.length, 2);

  const gone = recorder(404, 200);
  const [r2] = await sendAlert([{ kind: "slack", target: "https://hooks.slack.com/services/T/B/x" }], message, { fetchImpl: gone.fetchImpl });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /HTTP 404/);
  assert.equal(gone.calls.length, 1);

  const offline = async () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
  };
  const [r3] = await sendAlert([{ kind: "ntfy", target: "https://ntfy.sh/x" }], message, { fetchImpl: offline });
  assert.deepEqual(r3, { kind: "ntfy", ok: false, error: "ENOTFOUND" });
});

test("channels are validated, kept in credentials.env, and masked when listed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agouti-alerts-"));
  const p = paths({ AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") });
  await saveConfig({ repository: "/x", projects: {} }, p);

  await assert.rejects(saveAlert("discord", "https://example.com/hook", p), /isn't a discord.com URL/);
  await assert.rejects(saveAlert("slack", "http://hooks.slack.com/x", p), /must start with https/);
  await assert.rejects(saveAlert("telegram", "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", p), /bot token and the chat id/);
  await assert.rejects(saveAlert("pager", "https://x", p), /Unknown alert channel/);

  await saveAlert("discord", "https://discord.com/api/webhooks/1234567890/SECRETTOKEN", p);
  await saveAlert("telegram", "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 42", p);
  assert.equal((await loadCredentials(p)).AGOUTI_ALERT_DISCORD, "https://discord.com/api/webhooks/1234567890/SECRETTOKEN");
  const listed = (await loadAlerts(p)).map((c) => describeTarget(c.kind, c.target));
  assert.deepEqual(listed, ["discord.com/api/webho…", "chat 42"]);
  assert.ok(!listed.join().includes("SECRET"));

  await saveAlert("discord", null, p);
  assert.deepEqual(
    (await loadAlerts(p)).map((c) => c.kind),
    ["telegram"],
  );
  assert.ok(Object.values(CHANNELS).every((c) => c.help && c.validate));
});

test("Telegram: the chat is the last one that wrote to the bot", async () => {
  const updates = { ok: true, result: [{ message: { chat: { id: 1, first_name: "Old" } } }, { message: { chat: { id: -100, title: "Ops team" } } }] };
  const fetchImpl = async (url) => {
    assert.equal(url, "https://api.telegram.org/bot123:tok/getUpdates");
    return new Response(JSON.stringify(updates));
  };
  assert.deepEqual(await telegramChat("123:tok", { fetchImpl }), { id: "-100", name: "Ops team" });
  const none = async () => new Response(JSON.stringify({ ok: true, result: [] }));
  assert.equal(await telegramChat("123:tok", { fetchImpl: none }), null);
  const bad = async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });
  await assert.rejects(telegramChat("123:tok", { fetchImpl: bad }), /Telegram refused the token: Unauthorized/);
});

test("interactive: a channel whose test alert fails is only saved if you say so", async () => {
  const root = await mkdtemp(join(tmpdir(), "agouti-alerts-"));
  const p = paths({ AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") });
  await saveConfig({ repository: "/x", projects: {} }, p);
  const unreachable = "https://127.0.0.1:59999/hook"; // nothing listens there

  const cancel = scripted([
    ["select", /Where should alerts go/, "webhook"],
    ["input", /URL/, unreachable],
    ["select", /What now/, "cancel"],
  ]);
  let out = await captured(() => addChannel(cancel, { p }));
  assert.match(out, /✕ The test alert failed: ECONNREFUSED/);
  assert.deepEqual(await loadAlerts(p), []);

  const keep = scripted([
    ["select", /Where should alerts go/, "webhook"],
    ["input", /URL/, (o) => (assert.match(o.validate("http://x"), /https/), unreachable)],
    ["select", /What now/, "save"],
  ]);
  out = await captured(() => addChannel(keep, { p }));
  assert.deepEqual(await loadAlerts(p), [{ kind: "webhook", target: unreachable }]);
});
