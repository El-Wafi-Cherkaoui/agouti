// Shows a backup as it runs. Used by `agouti backup` and "Back up now" in the app.
// In a terminal, a live progress line; elsewhere (timers, logs) only final lines.
import { backupApps } from "../backup.js";
import { requireConfig } from "../config.js";
import { formatBytes } from "../detect.js";
import { loadHealthcheck, ping } from "../healthcheck.js";
import { paths } from "../paths.js";
import { DEFAULT_RETENTION, applyRetention } from "../retention.js";
import { ensureRestic, resticEnv } from "../restic.js";
import { checkProtection } from "../protection.js";
import { flaggedChanges, loadState, recordScheduled } from "../state.js";
import { CHANNELS, loadAlerts, sendAlert } from "../alerts.js";
import { hostname } from "node:os";
import { verifyDue } from "../verify.js";
import { runVerify, verifySummary } from "./verify.js";
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
// points no longer needed, and tell the healthcheck and the alert channels how it
// went. Output goes to the journal: `journalctl -u agouti-backup`. Returns true if
// everything worked.
export async function scheduledBackup(names = [], { p = paths() } = {}) {
  const url = await loadHealthcheck(p).catch(() => null);
  if (url) await ping(url, "start");
  const report = []; // everything, for the healthcheck
  const problems = []; // what went wrong and what to do, for the alerts
  const fail = (line, ...detail) => problems.push(line, ...detail.filter(Boolean).map((d) => `  ${d}`));
  let ok = false;
  try {
    const results = await runBackup(names, { p, live: false });
    for (const r of results) {
      report.push(r.ok ? `${r.app}: ok` : `${r.app}: FAILED ${failureText(r)}`);
      for (const part of ["database", "files"]) {
        if (!r[part].ok) fail(`${r.app}: the ${part} wasn't backed up: ${r[part].error}`, r[part].hint);
        if (r[part].warning) report.push(`${r.app}: ${r[part].warning}`);
      }
    }
    // The backup was saved, but it doesn't hold everything: that has to reach someone.
    for (const r of results) {
      if (r.files.unreadable) fail(`${r.app}: ${r.files.unreadable}`, "The rest was backed up. Check who can read these files, or exclude them in agouti.yml.");
      if (r.shrunk) fail(`${r.app}: ${r.shrunk}`, "If it's expected, accept it: sudo agouti → Accept a change in the data.");
    }
    ok = results.every((r) => r.ok && !r.files.unreadable && !r.shrunk);

    const config = await requireConfig(p);
    const policy = config.retention ?? DEFAULT_RETENTION;

    // Append-only storage: still in place? (Someone could have removed the lock
    // rules or turned off versioning.) A few cheap requests, every run.
    if (config.protection) {
      try {
        const check = await checkProtection(config, { p });
        if (check.protected) {
          info(`${green("✓")} Append-only storage: in place`);
          report.push("Append-only storage: in place");
        } else {
          ok = false;
          const broken = check.checks.filter((c) => !c.ok).map((c) => `${c.name} ${c.detail}`);
          info(`${red("✕")} Append-only storage is no longer in place: ${broken.join("; ")}`);
          report.push(`Append-only storage FAILED: ${broken.join("; ")}`);
          fail(`The backups are no longer append-only: ${broken.join("; ")}`, "Someone may have removed the protection. Check it: sudo agouti protect --check");
        }
      } catch (err) {
        ok = false;
        info(`${red("✕")} Couldn't check the append-only storage: ${err.message}`);
        report.push(`Append-only storage check FAILED: ${err.message}`);
        fail(`Couldn't check the append-only storage: ${err.message}`);
      }
    }

    // R2 bucket locks: nothing can be deleted, so retention would only fail. Paused.
    if (config.protection?.kind === "r2") {
      const line = "Retention paused: the storage is append-only (R2 bucket locks), so nothing is deleted";
      info(dim(line));
      report.push(line);
    } else
      try {
        const bin = await ensureRestic({ p, log: info });
        // While an app's data looks damaged, its older (healthy) points must not be
        // pushed out by the new ones: nothing is deleted for it until it's resolved.
        const hold = flaggedChanges(await loadState(p)).map((f) => f.app);
        for (const app of hold) {
          const line = `Retention paused for ${app}: its data shrank sharply, so older restore points are kept`;
          info(`${yellow("⚠")} ${line}`);
          report.push(line);
        }
        const kept = await applyRetention(config, { bin, env: await resticEnv(config, p), policy, log: info, hold });
        const deleted = Object.values(kept.apps).reduce((n, a) => n + a.deleted, 0);
        const line = `Retention (${policy.daily} daily, ${policy.weekly} weekly, ${policy.monthly} monthly): ${deleted ? `deleted ${deleted} old restore ${deleted === 1 ? "point" : "points"}` : "nothing to delete"}`;
        info(`${green("✓")} ${line}`);
        report.push(line);
      } catch (err) {
        ok = false;
        info(`${red("✕")} ${err.message}`);
        report.push(`Retention FAILED: ${err.message}`);
        fail(`Old restore points couldn't be deleted: ${err.message}`, "Storage keeps growing until this is fixed.");
      }

    // The weekly restore test, in the same run so the healthcheck hears about it.
    // "Restores but looks wrong" counts as a failure here: that's what should alert.
    if (!config.verify) report.push("Restore tests: not set up (sudo agouti → Test a restore)");
    else if (verifyDue(config, await loadState(p))) {
      try {
        const v = await runVerify([], { p, live: false });
        report.push(...verifySummary(v));
        if (!v.ok) ok = false;
        for (const a of v.apps.filter((a) => a.status !== "verified")) {
          const why = [a.database?.error, a.files?.error, ...(a.problems ?? [])].filter(Boolean);
          fail(
            a.status === "warning" ? `${a.app}: the backup restores, but looks wrong:` : `${a.app}: the weekly restore test failed:`,
            ...why,
            "See for yourself: sudo agouti verify",
          );
        }
        if (!v.repository.ok) fail(`The backup storage has errors: ${v.repository.error}`, "Run restic check for details, then sudo agouti verify.");
      } catch (err) {
        ok = false;
        info(`${red("✕")} Restore test: ${err.message}`);
        report.push(`Restore test FAILED: ${err.message}`);
        fail(`The weekly restore test couldn't run: ${err.message}`, err.hint);
      }
    }
  } catch (err) {
    // Not set up, no apps, another backup running...: the healthcheck and the alerts must hear about it too.
    report.push(`FAILED: ${err.message}${err.hint ? `\n${err.hint}` : ""}`);
    if (url) await ping(url, "fail", report.join("\n"));
    fail(`The backup didn't run: ${err.message}`, err.hint);
    await alert(false, problems, p);
    throw err;
  }
  if (url) {
    const sent = await ping(url, ok ? "success" : "fail", report.join("\n"));
    if (!sent.ok) warn(`Couldn't ping the healthcheck: ${sent.error}`);
  }
  await alert(ok, problems, p);
  return ok;
}

// A message on each alert channel: on any problem, and once when things work again.
async function alert(ok, problems, p) {
  const previous = (await loadState(p).catch(() => ({}))).lastScheduled;
  await recordScheduled(ok, p).catch(() => {});
  const channels = await loadAlerts(p).catch(() => []);
  if (!channels.length) return;
  let message;
  if (!ok) {
    const n = problems.filter((l) => !l.startsWith("  ")).length || 1;
    message = {
      event: "failure",
      title: `✕ Agouti on ${hostname()}: ${n === 1 ? "a problem" : `${n} problems`} with tonight's backup`,
      lines: [...(problems.length ? problems : ["Something failed: see journalctl -u agouti-backup"]), "  Details: journalctl -u agouti-backup"],
    };
  } else if (previous && !previous.ok) {
    message = { event: "recovered", title: `✓ Agouti on ${hostname()}: backups are working again`, lines: ["Tonight's backup went fine."] };
  } else return;
  for (const r of await sendAlert(channels, message)) {
    if (r.ok) info(dim(`Alert sent: ${CHANNELS[r.kind].name}`));
    else warn(`Couldn't send the ${CHANNELS[r.kind].name} alert: ${r.error}`);
  }
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
      if (r.shrunk) info(`${yellow("⚠")} ${bold(r.app)}: ${r.shrunk}`);
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
