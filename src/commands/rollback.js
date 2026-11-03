import { requireConfig } from "../config.js";
import { paths } from "../paths.js";
import { defaultAsk } from "../prompts.js";
import { protectionKind, rollback } from "../protection.js";
import { ensureRestic, resticEnv, run } from "../restic.js";
import { UserError, bold, dim, info, ok } from "../ui.js";

export const usage = `Usage: agouti rollback --to "YYYY-MM-DD HH:MM" [--yes]

After an attack on append-only storage: puts the backup storage back as it was
at that moment (UTC). Works with this server's own key, e.g. on a rebuilt server.

  S3, B2, ...     every file written after that time is hidden again, every file
                  deleted or overwritten since gets its previous version back
                  (as long as your lifecycle rule still keeps it)
  Cloudflare R2   the locked folders couldn't be touched; this rebuilds the index,
                  the one part an attacker could have damaged

Shows what would change and asks first, unless --yes.

Then check the result: sudo agouti verify`;

export const options = { to: { type: "string" }, yes: { type: "boolean" } };

export function parseWhen(text) {
  const t = String(text ?? "").trim();
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t) ? t.replace(" ", "T") + "Z" : t;
  const d = new Date(iso);
  if (!t || Number.isNaN(d.getTime())) throw new UserError(`Not a time: ${text}`, 'Use "YYYY-MM-DD HH:MM" in UTC, e.g. --to "2026-11-03 02:00".');
  return d;
}

export async function rollbackCommand({ values }, { ask = defaultAsk, p = paths(), tty = process.stdin.isTTY && process.stdout.isTTY } = {}) {
  const config = await requireConfig(p);
  const kind = protectionKind(config.repository);
  if (kind === "r2") {
    info(dim("R2 lock rules kept config, keys, snapshots and data untouched. Rebuilding the index from the data..."));
    const bin = await ensureRestic({ p, log: info });
    const r = await run(bin, ["repair", "index"], { env: await resticEnv(config, p) });
    if (r.code !== 0) throw new UserError(`Rebuilding the index failed: ${r.stderr.trim().split("\n").at(-1)}`);
    return ok("Index rebuilt. Check the backups: sudo agouti verify");
  }
  if (!kind) throw new UserError("This storage isn't versioned: there's nothing to roll back to.");
  if (!values.to) throw new UserError('When to? e.g. --to "2026-11-03 02:00" (UTC): a moment before the attack.');
  const when = parseWhen(values.to);

  info(dim("Looking at every version in the storage..."));
  const plan = await rollback(config, when, { p, dryRun: true });
  info(
    `Back to ${bold(when.toISOString().replace("T", " ").slice(0, 19))} UTC: ${plan.restored} files get their old version back, ${plan.hidden} files written since are hidden, ${plan.unchanged} unchanged.`,
  );
  if (!plan.restored && !plan.hidden) return ok("Nothing changed since then.");
  if (!values.yes) {
    if (!tty) throw new UserError("Add --yes to roll back.");
    if (!(await ask.confirm({ message: "Roll back?", default: false }))) return info("Nothing was changed.");
  }
  const done = await rollback(config, when, { p });
  ok(`Rolled back: ${done.restored} restored, ${done.hidden} hidden. Nothing was deleted: it can be undone the same way.`);
  info(dim("Check the backups now: sudo agouti verify"));
}
