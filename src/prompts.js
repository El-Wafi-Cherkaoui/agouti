// Questions shared by the commands and the interactive app. Each takes the prompt
// functions as a parameter (`ask`), so tests can script the answers.
import * as inquirer from "@inquirer/prompts";
import { PROVIDERS, buildRepository, localDiskWarning } from "./storage.js";
import { UserError, red, yellow } from "./ui.js";

export const defaultAsk = {
  select: inquirer.select,
  input: inquirer.input,
  password: inquirer.password,
  confirm: inquirer.confirm,
  checkbox: inquirer.checkbox,
};

const nonEmpty = (v) => (v.trim() ? true : "Required");
const S3_PROVIDERS = ["r2", "s3", "b2", "s3-compatible"];

// Where backups go. On a mistake (bad bucket name, bad region...) the user is
// asked again with their previous answers prefilled, instead of starting over.
// warnLocal: when creating a repository, warn about local storage on the system disk.
export async function askStorage(ask = defaultAsk, { warnLocal = false } = {}) {
  let prev = {};
  for (;;) {
    const a = { provider: await ask.select({ message: "Where should backups go?", choices: PROVIDERS, default: prev.provider }) };
    if (a.provider !== prev.provider) prev = { provider: a.provider };
    const text = (key, message, opts = {}) => ask.input({ message, default: prev[key] ?? opts.default, required: opts.required });

    if (a.provider === "r2") a.accountId = await text("accountId", "Cloudflare account ID (dashboard → R2 → Account details)", { required: true });
    if (a.provider === "s3") a.region = await text("region", "Region", { default: "eu-west-1" });
    if (a.provider === "b2") a.region = await text("region", "Region (from the bucket's S3 endpoint)", { default: "us-west-004" });
    if (a.provider === "s3-compatible") {
      a.endpoint = await text("endpoint", "Endpoint URL", { required: true });
      a.region = await text("region", "Region (leave empty if not needed)");
    }
    if (S3_PROVIDERS.includes(a.provider)) {
      a.bucket = await text("bucket", "Bucket", { required: true });
      a.prefix = await text("prefix", "Folder inside the bucket (optional)");
      Object.assign(a, await askS3Keys(ask, prev.accessKey));
    }
    if (a.provider === "sftp") a.sftpTarget = await text("sftpTarget", "Target (user@host:/path, uses root's SSH key)", { required: true });
    if (a.provider === "local") a.path = await text("path", "Directory", { default: "/mnt/backups/agouti" });

    let result;
    try {
      result = buildRepository(a);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      console.log(`${red("✕")} ${err.message} Let's try that again.\n`);
      prev = a;
      continue;
    }

    const warning = warnLocal && localDiskWarning(result.repository);
    if (!warning) return result;
    console.log(`\n${yellow("⚠")} ${warning.replace(/\n/g, "\n  ")}\n`);
    if (await ask.confirm({ message: "Use this directory anyway?", default: false })) return result;
    prev = a;
  }
}

export async function askS3Keys(ask = defaultAsk, accessKeyDefault) {
  const accessKey = await ask.input({ message: "Access key ID", default: accessKeyDefault, required: true });
  const secretKey = await ask.password({ message: "Secret access key", mask: "*", validate: nonEmpty });
  return { accessKey, secretKey };
}

export function askRecoveryKey(ask = defaultAsk) {
  return ask.password({ message: "Recovery key (agouti-rk-...)", mask: "*", validate: nonEmpty });
}

export function requireTty(hint) {
  if (!process.stdin.isTTY) throw new UserError("Not running in a terminal, so I can't ask questions.", hint);
}
