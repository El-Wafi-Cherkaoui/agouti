import { statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { UserError } from "./ui.js";

// Storage choices offered by `agouti init`. Each one turns answers into a restic
// repository string plus the environment restic needs to reach it.
export const PROVIDERS = [
  { value: "r2", name: "Cloudflare R2" },
  { value: "s3", name: "Amazon S3" },
  { value: "b2", name: "Backblaze B2 (S3 API)" },
  { value: "s3-compatible", name: "Other S3-compatible (MinIO, Wasabi, ...)" },
  { value: "sftp", name: "SFTP server" },
  { value: "local", name: "Local directory or mounted disk" },
];

const trimSlashes = (s) => s.trim().replace(/^\/+|\/+$/g, "");

function bucketPath(bucket, prefix) {
  const b = trimSlashes(bucket);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b)) throw new UserError(`"${bucket}" isn't a valid bucket name.`);
  const pre = prefix ? trimSlashes(prefix) : "";
  return pre ? `${b}/${pre}` : b;
}

function endpointUrl(endpoint) {
  let url = endpoint.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  try {
    new URL(url);
  } catch {
    throw new UserError(`"${endpoint}" isn't a valid URL.`);
  }
  return url;
}

// answers: { provider, accountId, region, endpoint, bucket, prefix, accessKey, secretKey, sftpTarget, path }
export function buildRepository(a) {
  const s3Env = () => ({ AWS_ACCESS_KEY_ID: a.accessKey, AWS_SECRET_ACCESS_KEY: a.secretKey });
  switch (a.provider) {
    case "r2": {
      if (!/^[0-9a-f]{32}$/i.test(a.accountId?.trim() ?? ""))
        throw new UserError("A Cloudflare account ID is 32 hex characters (dashboard → R2 → Account details).");
      return {
        repository: `s3:https://${a.accountId.trim().toLowerCase()}.r2.cloudflarestorage.com/${bucketPath(a.bucket, a.prefix)}`,
        env: { ...s3Env(), AWS_DEFAULT_REGION: "auto" },
      };
    }
    case "s3": {
      const region = a.region?.trim();
      if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region ?? "")) throw new UserError(`"${a.region}" doesn't look like an AWS region (e.g. eu-west-1).`);
      return {
        repository: `s3:https://s3.${region}.amazonaws.com/${bucketPath(a.bucket, a.prefix)}`,
        env: { ...s3Env(), AWS_DEFAULT_REGION: region },
      };
    }
    case "b2": {
      const region = a.region?.trim();
      if (!/^[a-z]+-[a-z]+-\d{3}$/.test(region ?? "")) throw new UserError(`"${a.region}" doesn't look like a B2 region (e.g. us-west-004).`);
      return {
        repository: `s3:https://s3.${region}.backblazeb2.com/${bucketPath(a.bucket, a.prefix)}`,
        env: { ...s3Env(), AWS_DEFAULT_REGION: region },
      };
    }
    case "s3-compatible":
      return {
        repository: `s3:${endpointUrl(a.endpoint)}/${bucketPath(a.bucket, a.prefix)}`,
        env: { ...s3Env(), ...(a.region?.trim() ? { AWS_DEFAULT_REGION: a.region.trim() } : {}) },
      };
    case "sftp": {
      const t = a.sftpTarget?.trim() ?? "";
      if (!/^[^@\s]+@[^:\s]+:.+$/.test(t)) throw new UserError(`Expected user@host:/path, got "${a.sftpTarget}".`);
      return { repository: `sftp:${t}`, env: {} };
    }
    case "local": {
      const dir = a.path?.trim() ?? "";
      if (!dir) throw new UserError("A directory is required.");
      return { repository: isAbsolute(dir) ? dir : resolve(dir), env: {} };
    }
    default:
      throw new UserError(`Unknown storage provider: ${a.provider}`);
  }
}

// For `--repo`: a restic repository string given directly.
export function repositoryNeedsS3Keys(repository) {
  return repository.startsWith("s3:");
}

// Shown in messages; repository strings carry no secrets, but keep them short.
export function describeRepository(repository) {
  if (repository.startsWith("s3:")) {
    const host = repository
      .slice(3)
      .replace(/^https?:\/\//, "")
      .split("/")[0];
    if (host.endsWith(".r2.cloudflarestorage.com")) return "R2";
    if (host.endsWith(".amazonaws.com")) return "S3";
    if (host.endsWith(".backblazeb2.com")) return "B2";
    return `S3 (${host})`;
  }
  if (repository.startsWith("sftp:")) return `SFTP (${repository.slice(5).split(":")[0]})`;
  return `local (${repository})`;
}

// A local repository on the same disk as the system doesn't survive losing the
// server (disk failure, deleted VPS, an attacker with root). Returns a warning to
// show, or null when the directory is on a separate disk or mount.
export function localDiskWarning(repository) {
  if (/^(s3|sftp|rest|b2|azure|gs|swift|rclone):/.test(repository)) return null;
  let dir = resolve(repository);
  // The directory may not exist yet: look at the closest parent that does.
  for (;;) {
    try {
      if (statSync(dir).dev !== statSync("/").dev) return null;
      break;
    } catch {
      if (dir === dirname(dir)) return null;
      dir = dirname(dir);
    }
  }
  return [
    `${repository} is on the same disk as this server's system.`,
    "Backups there protect against mistakes (a deleted file, a bad migration), but not against",
    "losing the server: a failed disk, a deleted VPS, or an attacker with root takes them too.",
    "If you meant to use a separate disk, make sure it's mounted first.",
    "For real protection, store backups off this server (R2, S3, B2 or SFTP).",
  ].join("\n");
}
