// Append-only storage: an attacker who takes over this server (and so has its
// storage keys) can add backups, but can't delete or overwrite the ones there.
//
// Two ways, depending on the storage:
//   r2          Cloudflare R2 bucket locks: everything restic keeps (config, keys,
//               snapshots, data) can never be deleted or overwritten, by anyone,
//               until the lock rules are removed with a Cloudflare admin token,
//               which is never stored here. locks/ stays open (restic must remove
//               its own lock files) and so does index/ (rebuilt from the data if
//               tampered with). Nothing is deleted automatically: retention pauses.
//   versioning  AWS S3, Backblaze B2 and other S3-compatible storage: with
//               versioning on and a key that can't delete versions, a delete or
//               overwrite only hides the file; the previous version is kept for
//               as long as the bucket's lifecycle rule says. Retention works as usual.
//
// Checks never risk real data: for R2 they rely on the lock being checked before
// the If-None-Match precondition (documented by Cloudflare), so a probe on an
// existing object fails either way and changes nothing; for versioning, they only
// touch a probe object of Agouti's own.
import { loadCredentials, saveConfig } from "./config.js";
import { paths } from "./paths.js";
import { s3Client } from "./s3.js";
import { UserError } from "./ui.js";

export const LOCKED = ["config", "keys/", "snapshots/", "data/"];
const RULE_IDS = { config: "agouti-config", "keys/": "agouti-keys", "snapshots/": "agouti-snapshots", "data/": "agouti-data" };

// "r2" | "versioning" | null (not possible: SFTP, local folder).
export function protectionKind(repository) {
  if (!String(repository).startsWith("s3:")) return null;
  return /\.r2\.cloudflarestorage\.com\//.test(repository) ? "r2" : "versioning";
}

// The provider, for instructions: "r2" | "aws" | "b2" | "s3".
export function provider(repository) {
  if (/\.r2\.cloudflarestorage\.com\//.test(repository)) return "r2";
  if (/\.amazonaws\.com\//.test(repository)) return "aws";
  if (/\.backblazeb2\.com\//.test(repository)) return "b2";
  return "s3";
}

async function client(config, p) {
  return s3Client(config.repository, { ...process.env, ...(await loadCredentials(p)) });
}

// Checks, with this server's own keys, that the storage refuses deletes.
// Returns { kind, protected, checks: [{ name, ok, detail }] }.
export async function checkProtection(config, { p = paths() } = {}) {
  const kind = protectionKind(config.repository);
  if (!kind) return { kind, protected: false, checks: [{ name: "storage", ok: false, detail: "SFTP and local folders can't be made append-only." }] };
  const c = await client(config, p);
  const checks = kind === "r2" ? await checkR2(c) : await checkVersioning(c);
  return { kind, protected: checks.every((x) => x.ok), checks };
}

async function checkR2(c) {
  const checks = [];
  for (const dir of LOCKED) {
    const key = dir === "config" ? c.full("config") : await c.firstKey(dir);
    if (!key) {
      checks.push({ name: dir, ok: false, detail: "nothing stored there yet: back up once, then check again" });
      continue;
    }
    // If-None-Match: * on an existing object: refused as locked (409), or as
    // already existing (412). Either way nothing is written.
    const r = await c.request("PUT", key, { headers: { "if-none-match": "*" } });
    if (r.status === 409 && r.code === "ObjectLockedByBucketPolicy") checks.push({ name: dir, ok: true, detail: "locked" });
    else if (r.status === 412) checks.push({ name: dir, ok: false, detail: "not locked: it could be deleted or overwritten" });
    else checks.push({ name: dir, ok: false, detail: `unexpected answer: HTTP ${r.status}${r.code ? ` ${r.code}` : ""}` });
  }
  // restic must still be able to remove its own lock files, or every backup fails.
  const probe = c.full(`locks/agouti-check-${Date.now()}`);
  const put = await c.request("PUT", probe, { body: "agouti" });
  const del = put.status === 200 ? await c.request("DELETE", probe) : put;
  checks.push(
    del.status === 204 || del.status === 200
      ? { name: "locks/", ok: true, detail: "open, as restic needs" }
      : { name: "locks/", ok: false, detail: `restic can't remove its lock files (HTTP ${del.status}${del.code ? ` ${del.code}` : ""}): backups would fail` },
  );
  return checks;
}

async function checkVersioning(c) {
  const checks = [];
  let status;
  try {
    status = await c.versioning();
  } catch (err) {
    const hint = /AccessDenied/.test(err.message) ? " (the key needs s3:GetBucketVersioning)" : "";
    return [{ name: "versioning", ok: false, detail: `${err.message}${hint}` }];
  }
  checks.push(
    status === "Enabled"
      ? { name: "versioning", ok: true, detail: "on: deleted or overwritten files keep their previous version" }
      : { name: "versioning", ok: false, detail: `${status.toLowerCase()}: deleted files would be gone for good` },
  );

  // A probe object of our own: write it, then try to delete its version for good.
  const key = c.full("agouti-protection-check");
  const put = await c.request("PUT", key, { body: `written by Agouti ${new Date().toISOString()}` });
  const version = put.headers.get("x-amz-version-id");
  if (put.status !== 200) {
    checks.push({ name: "key", ok: false, detail: `can't write (HTTP ${put.status}${put.code ? ` ${put.code}` : ""})` });
  } else if (!version || version === "null") {
    checks.push({ name: "key", ok: false, detail: "no version was kept for a new file" });
  } else {
    const del = await c.request("DELETE", key, { query: { versionId: version } });
    checks.push(
      del.status === 403 || del.status === 401
        ? { name: "key", ok: true, detail: "can't delete old versions" }
        : { name: "key", ok: false, detail: `can delete old versions (HTTP ${del.status}): an attacker could too` },
    );
  }
  await c.request("DELETE", key); // a delete marker; the old versions expire with the lifecycle rule
  return checks;
}

// R2: adds Agouti's lock rules through the Cloudflare API, keeping the bucket's
// other rules. The token is used for this call only.
export async function applyR2Locks(config, token, { fetchImpl = fetch } = {}) {
  const c = s3Client(config.repository, { AWS_ACCESS_KEY_ID: "-", AWS_SECRET_ACCESS_KEY: "-" });
  const account = c.host.split(".")[0];
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${c.bucket}/lock`;
  const headers = { authorization: `Bearer ${token.trim()}`, "content-type": "application/json" };
  const call = async (method, body) => {
    const res = await fetchImpl(url, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const msg = json.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
      throw new UserError(
        `Cloudflare refused to ${method === "GET" ? "read" : "update"} the bucket lock rules: ${msg}`,
        "The token needs R2 admin rights (Admin Read & Write).",
      );
    }
    return json.result;
  };
  const existing = ((await call("GET"))?.rules ?? []).filter((r) => !Object.values(RULE_IDS).includes(r.id));
  const ours = LOCKED.map((dir) => ({ id: RULE_IDS[dir], enabled: true, prefix: c.full(dir), condition: { type: "Indefinite" } }));
  await call("PUT", { rules: [...existing, ...ours] });
  return ours;
}

// Remembers that the storage is protected (and how), after a successful check.
export async function saveProtection(config, result, { keepDays, p = paths() } = {}) {
  config.protection = { kind: result.kind, checkedAt: new Date().toISOString(), ...(keepDays ? { keepDays } : {}) };
  await saveConfig(config, p);
}

// What to configure, for the versioning providers. Returns text.
export function versioningInstructions(repository, { days = 30 } = {}) {
  const c = s3Client(repository, { AWS_ACCESS_KEY_ID: "-", AWS_SECRET_ACCESS_KEY: "-" });
  const objects = `arn:aws:s3:::${c.bucket}/${c.prefix ? c.prefix.replace(/\/+$/, "") + "/" : ""}*`;
  switch (provider(repository)) {
    case "aws":
      return `In the AWS console, for bucket ${c.bucket}:

1. Properties → Bucket Versioning → Enable.
2. Management → Create lifecycle rule (all objects):
   "Permanently delete noncurrent versions" after ${days} days, and
   "Delete expired object delete markers".
   That's how long you'll have to notice an attack and roll back.
3. IAM → the user whose keys are on this server → replace its permissions with:

${awsPolicy(c.bucket, objects)}

   It can read and add backups, and hide files (as restic does when cleaning
   up), but not delete versions or change versioning and lifecycle rules.`;
    case "b2":
      return `In Backblaze, for bucket ${c.bucket}:

1. Bucket Settings → Lifecycle Settings → "Keep prior versions for this
   number of days": ${days}. B2 keeps versions of every file; this sets how long
   you'll have to notice an attack and roll back.
2. Create a new application key for this server (App Keys → Add a New
   Application Key), restricted to bucket ${c.bucket}, "Read and Write"…
   then remove deleteFiles. With the b2 command line tool:

   b2 key create --bucket ${c.bucket} agouti-${c.bucket} listBuckets,listFiles,readFiles,writeFiles

   Without deleteFiles, the key can hide files (as restic does when cleaning up)
   but not delete any version.
3. Give the new key to Agouti in the next step.`;
    default:
      return `On your S3-compatible storage, for bucket ${c.bucket}:

1. Turn on versioning.
2. Add a lifecycle rule that permanently deletes noncurrent versions after
   ${days} days: that's how long you'll have to notice an attack and roll back.
3. Give this server a key that can list, read, write and delete objects (a
   delete only hides a file in a versioned bucket), but NOT delete object
   versions or change the bucket's versioning, lifecycle or policy. In AWS
   policy terms:

${awsPolicy(c.bucket, objects)}`;
  }
}

function awsPolicy(bucket, objects) {
  return JSON.stringify(
    {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AgoutiBucket",
          Effect: "Allow",
          Action: ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation", "s3:GetBucketVersioning"],
          Resource: `arn:aws:s3:::${bucket}`,
        },
        { Sid: "AgoutiObjects", Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject"], Resource: objects },
      ],
    },
    null,
    2,
  )
    .split("\n")
    .map((l) => "   " + l)
    .join("\n");
}

// Versioned storage, after an attack: puts every file back as it was at `when`,
// with this server's own key (it can hide files and copy old versions back, which
// is all this takes). Files written after `when` are hidden, files deleted or
// overwritten after it get their old version back. restic's lock files are left
// alone. dryRun: only count. Returns { restored, hidden, unchanged }.
export async function rollback(config, when, { p = paths(), dryRun = false, onProgress = () => {} } = {}) {
  if (protectionKind(config.repository) !== "versioning") throw new UserError("Rolling back is for versioned storage (S3, B2...).");
  const c = await client(config, p);
  const byKey = new Map();
  for (const v of await c.versions()) {
    if (v.key.startsWith(c.full("locks/"))) continue;
    (byKey.get(v.key) ?? byKey.set(v.key, []).get(v.key)).push(v);
  }
  const plan = { restore: [], hide: [], unchanged: 0 };
  for (const [key, list] of byKey) {
    list.sort((a, b) => b.lastModified - a.lastModified);
    const current = list.find((v) => v.latest) ?? list[0];
    if (current.lastModified <= when) {
      plan.unchanged++;
      continue;
    }
    const then = list.find((v) => v.lastModified <= when);
    if (!then || then.deleteMarker) {
      // It didn't exist then: hide it (unless it's hidden already).
      if (current.deleteMarker) plan.unchanged++;
      else plan.hide.push(key);
    } else if (!current.deleteMarker && current.etag && current.etag === then.etag) {
      plan.unchanged++; // same content as then (e.g. rolled back already)
    } else plan.restore.push({ key, versionId: then.versionId });
  }
  if (!dryRun) {
    let done = 0;
    const total = plan.restore.length + plan.hide.length;
    for (const { key, versionId } of plan.restore) {
      await c.restoreVersion(key, versionId);
      onProgress(++done, total);
    }
    for (const key of plan.hide) {
      const r = await c.request("DELETE", key);
      if (r.status !== 204 && r.status !== 200) throw new UserError(`Couldn't hide ${key}: HTTP ${r.status}`);
      onProgress(++done, total);
    }
  }
  return { restored: plan.restore.length, hidden: plan.hide.length, unchanged: plan.unchanged };
}
