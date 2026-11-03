import { requireConfig } from "../config.js";
import { printChecks, protectFlow } from "../flows/protect.js";
import { paths } from "../paths.js";
import { defaultAsk } from "../prompts.js";
import { applyR2Locks, checkProtection, protectionKind, saveProtection } from "../protection.js";
import { UserError, info, ok, red } from "../ui.js";

export const usage = `Usage: agouti protect            Set it up (interactive)
       agouti protect --check    Check that the storage refuses deletes

Make the backup storage append-only: this server can add backups but not delete
or overwrite them, so someone who takes over the server can't destroy them.

  Cloudflare R2   bucket lock rules; Agouti can add them with a Cloudflare API
                  token (given once, in CLOUDFLARE_API_TOKEN with --r2-locks).
                  Nothing is deleted while they're on: retention pauses.
  S3, B2, ...     versioning, and a key that can't delete versions; deletes only
                  hide files for the number of days your lifecycle rule says.

Checks never touch real backup data.

Options:
  --check      Check with this server's key, and remember the result
  --r2-locks   R2: add the lock rules with the token in CLOUDFLARE_API_TOKEN`;

export const options = { check: { type: "boolean" }, "r2-locks": { type: "boolean" } };

export async function protect({ values }, { ask = defaultAsk, p = paths(), tty = process.stdin.isTTY && process.stdout.isTTY } = {}) {
  const config = await requireConfig(p);
  if (values["r2-locks"]) {
    if (protectionKind(config.repository) !== "r2") throw new UserError("--r2-locks is for Cloudflare R2 storage.");
    if (!process.env.CLOUDFLARE_API_TOKEN) throw new UserError("Set CLOUDFLARE_API_TOKEN to a token with R2 Admin Read & Write.");
    await applyR2Locks(config, process.env.CLOUDFLARE_API_TOKEN);
    ok("Lock rules added.");
  }
  if (values.check || values["r2-locks"]) {
    const result = await checkProtection(config, { p });
    printChecks(result);
    if (!result.protected) {
      process.exitCode = 1;
      return info(`${red("✕")} Not append-only: someone with this server's keys could delete the backups.`);
    }
    await saveProtection(config, result, { keepDays: config.protection?.keepDays, p });
    return ok("Append-only storage is in place.");
  }
  if (!tty) throw new UserError("Run `sudo agouti protect` in a terminal to set it up, or use --check.");
  await protectFlow(ask, { p });
}
