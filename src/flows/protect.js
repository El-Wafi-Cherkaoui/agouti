// Append-only storage, interactively ("Protect backups from deletion" in the app,
// or `sudo agouti protect` in a terminal).
import { loadCredentials, requireConfig, saveCredentials } from "../config.js";
import { paths } from "../paths.js";
import { askS3Keys } from "../prompts.js";
import { LOCKED, applyR2Locks, checkProtection, protectionKind, provider, saveProtection, versioningInstructions } from "../protection.js";
import { ensureRestic, probeRepository, resticEnv } from "../restic.js";
import { s3Client } from "../s3.js";
import { UserError, bold, dim, green, info, ok, red, warn, yellow } from "../ui.js";

export function explainProtection() {
  info(`
${bold("Append-only storage")}
Your backups are only as safe as this server's storage keys. Someone who takes
over the server (a hacked app, a stolen SSH key, ransomware) can use those keys
to delete every backup, and often does before demanding money.

With append-only storage, this server can add backups but can't delete or
overwrite them. Even with full control of the server, the backups survive.
`);
}

export async function protectFlow(ask, { p = paths() } = {}) {
  const config = await requireConfig(p);
  const kind = protectionKind(config.repository);
  explainProtection();
  if (!kind) {
    throw new UserError(
      "This storage can't be made append-only (SFTP and local folders can't refuse deletes).",
      "Use Cloudflare R2, AWS S3 or Backblaze B2 for backups you want protected.",
    );
  }
  if (kind === "r2") await setUpR2(ask, config, p);
  else await setUpVersioning(ask, config, p);
}

async function setUpR2(ask, config, p) {
  const c = s3Client(config.repository, { AWS_ACCESS_KEY_ID: "-", AWS_SECRET_ACCESS_KEY: "-" });
  info(`On Cloudflare R2 this is done with ${bold("bucket lock rules")} on bucket ${bold(c.bucket)}:
${LOCKED.map((d) => `  · ${c.full(d)}`).join("\n")}
can then never be deleted or overwritten, by anyone, until the rules are removed
in your Cloudflare account. (locks/ and index/ stay open: restic needs them, and
the index can be rebuilt from the data.)

${yellow("⚠")} Nothing in those folders can be deleted while the rules are on, not even by
  Agouti's own cleanup: old restore points are kept and storage only grows.
  Backups deduplicate, so growth is usually modest.
`);
  const how = await ask.select({
    message: "How do you want to add the rules?",
    choices: [
      { value: "token", name: "Agouti adds them (recommended)", description: "Needs a Cloudflare API token once. It isn't stored on this server." },
      { value: "manual", name: "I'll add them in the Cloudflare dashboard", description: "Then Agouti checks they work." },
      { value: "cancel", name: "Cancel" },
    ],
  });
  if (how === "cancel") return;
  if (how === "token") {
    info(`
Create a token in the Cloudflare dashboard: R2 → Manage API tokens → Create
Account API token → permissions ${bold("Admin Read & Write")}. Copy the ${bold("Token value")}.
Agouti uses it once to add the rules, then forgets it. Delete the token
afterwards if you like.
`);
    const token = await ask.password({
      message: "Cloudflare API token",
      mask: "*",
      validate: (v) => v.trim().length > 20 || "That doesn't look like a token.",
    });
    info(dim("Adding the lock rules..."));
    await applyR2Locks(config, token);
    ok("Lock rules added.");
  } else {
    info(`
In the Cloudflare dashboard: R2 → ${c.bucket} → Settings → Bucket lock rules →
Add rule, four times (retention: ${bold("Indefinite")}):
${LOCKED.map((d) => `  · prefix ${bold(c.full(d))}`).join("\n")}
`);
    await ask.confirm({ message: "Done?", default: true });
  }
  await checkAndSave(ask, config, p);
}

async function setUpVersioning(ask, config, p) {
  const days = 30;
  info(`On ${{ aws: "AWS S3", b2: "Backblaze B2", s3: "your storage" }[provider(config.repository)]} this is done with ${bold("versioning")}: a delete or overwrite only hides
a file, and the previous version is kept for ${days} days. This server's key gets
permission to hide files (restic's cleanup keeps working) but not to delete
versions. After an attack, the backups can be rolled back to how they were.

${versioningInstructions(config.repository, { days })}
`);
  const key = await ask.select({
    message: "Which key does this server use now?",
    choices: [
      { value: "same", name: "The same key as before (I changed its permissions)" },
      { value: "new", name: "A new key: let me enter it" },
      { value: "cancel", name: "Cancel" },
    ],
  });
  if (key === "cancel") return;
  if (key === "new") await replaceKey(ask, config, p);
  await checkAndSave(ask, config, p, { keepDays: days });
}

// Swaps this server's S3 key, after checking restic can open the repository with it.
async function replaceKey(ask, config, p) {
  const old = await loadCredentials(p);
  for (;;) {
    const { accessKey, secretKey } = await askS3Keys(ask);
    const creds = { ...old, AWS_ACCESS_KEY_ID: accessKey.trim(), AWS_SECRET_ACCESS_KEY: secretKey.trim() };
    const bin = await ensureRestic({ p, log: info });
    const env = { ...(await resticEnv(config, p)), ...creds };
    const probe = await probeRepository(bin, env);
    if (probe.state === "ok") {
      await saveCredentials(creds, p);
      ok("New key saved. The old one can be deleted in your storage account.");
      return;
    }
    info(`${red("✕")} restic can't open the repository with that key: ${probe.message ?? probe.state}`);
    if (!(await ask.confirm({ message: "Try another key?", default: true }))) throw new UserError("Kept the old key. Nothing changed.");
  }
}

// Checks with this server's own key; saves only if the storage really refuses deletes.
async function checkAndSave(ask, config, p, opts = {}) {
  for (;;) {
    info(dim("\nChecking, with this server's own key..."));
    const result = await checkProtection(config, { p });
    printChecks(result);
    if (result.protected) {
      await saveProtection(config, result, { ...opts, p });
      ok(`Append-only storage is in place. Every scheduled backup checks it's still there.`);
      return true;
    }
    const nothingYet = result.checks.some((c) => /nothing stored there yet/.test(c.detail));
    const next = await ask.select({
      message: "Not protected yet. What now?",
      choices: [
        {
          value: "again",
          name: "Check again",
          description: nothingYet ? "Back up once first, so there's something to check." : "After fixing what's listed above.",
        },
        { value: "later", name: "Stop for now" },
      ],
    });
    if (next === "later") {
      warn("Not protected: an attacker on this server could still delete the backups.");
      return false;
    }
  }
}

export function printChecks(result) {
  for (const c of result.checks) info(`  ${c.ok ? green("✓") : red("✕")} ${c.name.padEnd(11)} ${c.detail}`);
}

// For the home screen header: "" when the storage can't be protected anyway.
export function protectionLabel(config) {
  if (!protectionKind(config.repository) && !config.protection) return "";
  if (!config.protection) return yellow("not append-only");
  return green(config.protection.kind === "r2" ? "append-only (R2 locks)" : "append-only (versioning)");
}
