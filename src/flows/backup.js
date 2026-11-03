// Shows a backup as it runs. Used by `agouti backup` and "Back up now" in the app.
// In a terminal, a live progress line; elsewhere (timers, logs) only final lines.
import { backupApps } from "../backup.js";
import { requireConfig } from "../config.js";
import { formatBytes } from "../detect.js";
import { loadHealthcheck, ping } from "../healthcheck.js";
import { paths } from "../paths.js";
import { DEFAULT_RETENTION, applyRetention } from "../retention.js";
import { ensureRestic, resticEnv } from "../restic.js";
import { bold, dim, green, info, red, warn, yellow } from "../ui.js";

export async function runBackup(names = [], { p = paths(), live = process.stdout.isTTY } = {}) {
  const results = await backupApps(names, { p, log: info, onEvent: reporter(live) });
  const failed = results.filter((r) => !r.ok);
  if (results.length > 1) {
    info(
      failed.length
        ? red(`\n✕ ${failed.length} of ${results.length} apps failed: ${failed.map((r) => r.app).join(", ")}`)
        : green(`\n✓ All ${results.length} apps backed up`),
    );
  }
  return results;
}

// What the daily timer runs (`agouti backup --scheduled`): back up, delete restore
// points no longer needed, and tell the healthcheck how it went. Output goes to the
// journal: `journalctl -u agouti-backup`. Returns true if everything worked.
export async function scheduledBackup(names = [], { p = paths() } = {}) {
  const url = await loadHealthcheck(p).catch(() => null);
  if (url) await ping(url, "start");
  const report = [];
  let ok = false;
  try {
    const results = await runBackup(names, { p, live: false });
    for (const r of results) report.push(r.ok ? `${r.app}: ok` : `${r.app}: FAILED ${failureText(r)}`);
    ok = results.every((r) => r.ok);

    const config = await requireConfig(p);
    const policy = config.retention ?? DEFAULT_RETENTION;
    try {
      const bin = await ensureRestic({ p, log: info });
      const kept = await applyRetention(config, { bin, env: await resticEnv(config, p), policy, log: info });
      const deleted = Object.values(kept.apps).reduce((n, a) => n + a.deleted, 0);
      const line = `Retention (${policy.daily} daily, ${policy.weekly} weekly, ${policy.monthly} monthly): ${deleted ? `deleted ${deleted} old restore ${deleted === 1 ? "point" : "points"}` : "nothing to delete"}`;
      info(`${green("✓")} ${line}`);
      report.push(line);
    } catch (err) {
      ok = false;
      info(`${red("✕")} ${err.message}`);
      report.push(`Retention FAILED: ${err.message}`);
    }
  } catch (err) {
    // Not set up, no apps, another backup running...: the healthcheck must hear about it too.
    report.push(`FAILED: ${err.message}${err.hint ? `\n${err.hint}` : ""}`);
    if (url) await ping(url, "fail", report.join("\n"));
    throw err;
  }
  if (url) {
    const sent = await ping(url, ok ? "success" : "fail", report.join("\n"));
    if (!sent.ok) warn(`Couldn't ping the healthcheck: ${sent.error}`);
  }
  return ok;
}

function failureText(r) {
  return ["database", "files"]
    .filter((part) => !r[part].ok)
    .map((part) => `${part}: ${r[part].error}`)
    .join("; ");
}

function reporter(live) {
  let line = false;
  const clear = () => {
    if (line) process.stdout.write("\r\x1b[2K");
    line = false;
  };
  return (e) => {
    if (e.type === "app-start") info(`\nBacking up ${bold(e.app)} ...`);
    if (e.type === "progress" && live) {
      const amount = e.totalBytes
        ? `${Math.floor((e.percent ?? 0) * 100)}% · ${formatBytes(e.bytesDone)} of ${formatBytes(e.totalBytes)}`
        : formatBytes(e.bytesDone);
      process.stdout.write(`\r\x1b[2K  ${dim(e.part.padEnd(9))} ${dim(amount)}`);
      line = true;
    }
    if (e.type === "part-done") {
      clear();
      info(`  ${partLine(e.part, e.result)}`);
      if (e.result.hint) info(`    ${dim(e.result.hint)}`);
      if (e.result.warning) info(`    ${yellow("⚠")} ${e.result.warning}`);
    }
    if (e.type === "app-done") {
      const r = e.result;
      const when = r.at.replace("T", " ").slice(0, 16);
      if (r.ok) info(`${green("✓")} Restore point ${bold(`${r.app} @ ${when}`)} ${dim("(UTC)")}`);
      else info(`${red("✕")} ${bold(r.app)}: backup incomplete. ${savedParts(r)}`);
      if (r.warning) info(`  ${yellow("⚠")} ${r.warning}`);
    }
  };
}

function partLine(part, r) {
  const label = part.padEnd(9);
  const secs = dim(`${r.seconds}s`);
  if (!r.ok) return `${red("✕")} ${label} ${r.error}`;
  if (r.skipped) return `${dim("-")} ${label} ${dim("no folders selected")}`;
  if (part === "database") return `${green("✓")} ${label} ${formatBytes(r.bytes)} dumped · ${formatBytes(r.added)} new · ${secs}`;
  const changes = r.newFiles || r.changed ? `${r.newFiles} new, ${r.changed} changed` : "no changes";
  return `${green("✓")} ${label} ${r.files.toLocaleString("en-US")} ${r.files === 1 ? "file" : "files"} · ${formatBytes(r.bytes)} · ${changes} · ${formatBytes(r.added)} uploaded · ${secs}`;
}

function savedParts(r) {
  if (r.database.ok && !r.files.ok) return "The database was saved; the files were not.";
  if (!r.database.ok && r.files.ok && !r.files.skipped) return "The files were saved; the database was not.";
  return "Nothing was saved.";
}
