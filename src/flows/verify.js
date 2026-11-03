// Restore tests, interactively ("Test a restore" in the app) and the output shared
// with `agouti verify` and the scheduled run.
import { ago } from "../app.js";
import { requireConfig } from "../config.js";
import { formatBytes } from "../detect.js";
import { paths } from "../paths.js";
import { UserError, bold, dim, green, info, ok, red, yellow } from "../ui.js";
import { VERIFY_USER, setupVerifier, verifyApps } from "../verify.js";
import { askAdmin } from "./restore.js";

export function explainVerify() {
  info(`
${bold("Restore tests")}
A backup you have never restored is a guess. Every week, Agouti restores the
latest backup of each app for real:
  · the database into a throwaway database, then counts tables and rows;
  · a sample of files, compared byte for byte with the live ones;
and warns you if something looks wrong, e.g. a table that suddenly lost most
of its rows. The throwaway database is deleted right after.

This needs a MySQL user that can create databases. Agouti creates
${bold(VERIFY_USER)}, which can only create and drop databases named
agouti_verify_*: it can't read or change your real databases.
`);
}

// Creates the verify user (through an admin login, used once). Returns true if set up.
export async function setupVerifyFlow(ask, { p = paths(), explained = false } = {}) {
  const config = await requireConfig(p);
  const first = Object.values(config.projects ?? {})[0];
  if (!first) throw new UserError("Add an app first: there's nothing to test yet.");
  if (!explained) explainVerify();
  const server = pick(first.database);
  const admin = await askAdmin(ask, { database: server }, p);
  await setupVerifier(server, { admin, p });
  ok(`Restore tests are set up (MySQL user ${VERIFY_USER}).`);
  return true;
}

const pick = (db) => (db.socket ? { socket: db.socket } : { host: db.host, port: db.port ?? 3306 });

export async function verifyFlow(ask, { p = paths() } = {}) {
  const config = await requireConfig(p);
  if (!config.verify) {
    await setupVerifyFlow(ask, { p });
    info("");
  }
  return runVerify([], { p });
}

// Runs the tests and prints them. Returns { apps, repository, ok }.
export async function runVerify(names = [], { p = paths(), live = process.stdout.isTTY } = {}) {
  let line = false;
  const clear = () => {
    if (line) process.stdout.write("\r\x1b[2K");
    line = false;
  };
  const r = await verifyApps(names, {
    p,
    log: info,
    onEvent: (e) => {
      if (e.type === "repository-done") {
        if (e.result.ok) info(`${green("✓")} Repository: no errors`);
        else info(`${red("✕")} Repository: ${e.result.error}. Run \`restic check\` for details.`);
      }
      if (e.type === "app-start") info(`\nTesting ${bold(e.app)}: restore point ${e.pointAt.replace("T", " ").slice(0, 16)} ${dim("(UTC)")} ...`);
      if (e.type === "progress" && live) {
        process.stdout.write(`\r\x1b[2K  ${dim(e.part.padEnd(9))} ${dim(formatBytes(e.bytesDone))}`);
        line = true;
      }
      if (e.type === "part-done") {
        clear();
        for (const l of partLines(e.part, e.result)) info(l);
      }
      if (e.type === "app-done") {
        const v = e.result;
        if (v.status === "verified") info(`${green("✓")} ${bold(v.app)}: backup verified`);
        if (v.status === "warning") info(`${yellow("⚠")} ${bold(v.app)}: the backup restores, but looks wrong:`);
        if (v.status === "failed") info(`${red("✕")} ${bold(v.app)}: restore test failed`);
        for (const pr of v.problems ?? []) info(`    ${pr}`);
      }
    },
  });
  return { ...r, ok: r.repository.ok && r.apps.every((a) => a.status === "verified") };
}

function partLines(part, r) {
  const label = part.padEnd(9);
  const secs = dim(`${r.seconds}s`);
  if (!r.ok) return [`  ${red("✕")} ${label} ${r.error}`, ...(r.hint ? [`    ${dim(r.hint)}`] : [])];
  if (r.skipped) return [`  ${dim("-")} ${label} ${dim(r.note ?? "nothing to test")}`];
  if (part === "database") {
    const extra = [r.views && plural(r.views, "view"), r.procedures && plural(r.procedures, "procedure")].filter(Boolean);
    const lines = [
      `  ${green("✓")} ${label} ${plural(r.tables, "table")} · ${plural(r.rows, "row")}${extra.length ? ` · ${extra.join(" · ")}` : ""} restored · ${secs}`,
    ];
    const dumpOnly = [r.notLoaded?.triggers && plural(r.notLoaded.triggers, "trigger"), r.notLoaded?.functions && plural(r.notLoaded.functions, "function")];
    if (dumpOnly.some(Boolean)) {
      lines.push(`    ${dim(`${dumpOnly.filter(Boolean).join(" and ")} checked in the dump only (binary logging is on: creating them needs SUPER)`)}`);
    }
    return lines;
  }
  const compared = r.compared ? ` · ${r.compared} identical to the live copy` : "";
  return [`  ${green("✓")} ${label} ${r.sampled} of ${plural(r.total, "file")} restored${compared} · ${secs}`];
}

const plural = (n, word) => `${Number(n).toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

// For the home screen.
export function verifyLabel(v, enabled) {
  if (!v) return dim(enabled ? "not tested yet" : "-");
  if (v.status === "verified") return `${green("✓")} ${ago(v.at)}`;
  if (v.status === "warning") return `${yellow("⚠")} ${ago(v.at)}`;
  return `${red("✕")} failed ${ago(v.at)}`;
}

// One line for the healthcheck report and the journal.
export function verifySummary(r) {
  const lines = r.apps.map((a) =>
    a.status === "verified"
      ? `${a.app}: restore test ok`
      : `${a.app}: restore test ${a.status.toUpperCase()}: ${[a.database?.error, a.files?.error, ...(a.problems ?? [])].filter(Boolean).join("; ")}`,
  );
  if (!r.repository.ok) lines.push(`Repository: ${r.repository.error}`);
  return lines;
}
