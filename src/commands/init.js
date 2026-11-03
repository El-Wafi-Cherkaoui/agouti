import { askS3Keys, askStorage, requireTty } from "../prompts.js";
import { assertNotConfigured, createRepository, s3CredentialsFromEnv } from "../repository.js";
import { describeRepository, localDiskWarning, repositoryNeedsS3Keys } from "../storage.js";
import { bold, info, ok, warn, yellow } from "../ui.js";

export const usage = `Usage: agouti init [--repo <restic-repository>]

Create the encrypted backup repository this server's apps will share.
Asks where backups should go, unless --repo is given (any restic repository
string, e.g. s3:https://host/bucket, sftp:user@host:/path or /mnt/backups).
For S3 with --repo, keys are read from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.

Tip: just run \`sudo agouti\` for guided setup.`;

export const options = { repo: { type: "string" } };

export async function init({ values }) {
  await assertNotConfigured(); // before asking anything
  let storage;
  if (values.repo) {
    storage = await fromFlag(values.repo);
    const warning = localDiskWarning(storage.repository);
    if (warning) warn(warning.replace(/\n/g, "\n  "));
  } else {
    requireTty("Pass --repo to choose storage without prompts.");
    storage = await askStorage(undefined, { warnLocal: true });
  }
  const { repository, env: credentials } = storage;
  const key = await createRepository({ repository, credentials }, { log: info });
  printCreated(repository, key);
  info("Next: run `sudo agouti` to add your apps.");
}

export function printCreated(repository, key) {
  info("");
  ok(`Repository created and encrypted ${bold(describeRepository(repository))}`);
  warn(yellow("Your recovery key (store it OUTSIDE this server, e.g. a password manager):"));
  info(`  ${bold(key)}`);
  info("  Without it, backups cannot be restored if this server is lost.");
  info("");
}

async function fromFlag(repository) {
  if (!repositoryNeedsS3Keys(repository)) return { repository, env: {} };
  const env = s3CredentialsFromEnv(repository);
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    requireTty("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
    const k = await askS3Keys();
    env.AWS_ACCESS_KEY_ID = k.accessKey;
    env.AWS_SECRET_ACCESS_KEY = k.secretKey;
  }
  return { repository, env };
}
