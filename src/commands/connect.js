import { normalizeRecoveryKey } from "../recovery-key.js";
import { askRecoveryKey, askS3Keys, requireTty } from "../prompts.js";
import { assertNotConfigured, connectRepository, s3CredentialsFromEnv } from "../repository.js";
import { describeRepository, repositoryNeedsS3Keys } from "../storage.js";
import { UserError, bold, info, ok } from "../ui.js";

export const usage = `Usage: agouti connect <restic-repository> [--recovery-key <key>]

Use an existing Agouti repository from this server, e.g. to restore after
moving to a new server. Asks for the recovery key unless --recovery-key is
given (prefer the prompt: command-line arguments end up in shell history).
For S3, keys are read from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or asked for.

Tip: just run \`sudo agouti\` for guided setup.`;

export const options = { "recovery-key": { type: "string" } };

export async function connect({ values, positionals }) {
  const repository = positionals[0];
  if (!repository) throw new UserError("Which repository?", usage);
  await assertNotConfigured();

  let key = values["recovery-key"];
  if (!key) {
    requireTty("Pass --recovery-key, or run this in a terminal.");
    key = await askRecoveryKey();
  }

  const credentials = {};
  if (repositoryNeedsS3Keys(repository)) {
    Object.assign(credentials, s3CredentialsFromEnv(repository));
    if (!credentials.AWS_ACCESS_KEY_ID || !credentials.AWS_SECRET_ACCESS_KEY) {
      requireTty("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
      const k = await askS3Keys();
      credentials.AWS_ACCESS_KEY_ID = k.accessKey;
      credentials.AWS_SECRET_ACCESS_KEY = k.secretKey;
    }
  }

  await connectRepository({ repository, credentials, key: normalizeRecoveryKey(key) }, { log: info });
  ok(`Connected to ${bold(describeRepository(repository))}`);
}
