// Append-only storage, against an in-memory S3 stand-in that behaves like a
// versioned bucket with a key that can't delete versions, or like Cloudflare R2
// with bucket lock rules. (Checked for real against an AWS emulator with IAM
// enforcement; this keeps the tests self-contained.)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseWhen } from "../src/commands/rollback.js";
import { loadConfig, saveConfig, saveCredentials, saveRecoveryKey } from "../src/config.js";
import { paths } from "../src/paths.js";
import { applyR2Locks, checkProtection, protectionKind, provider, rollback, saveProtection, versioningInstructions } from "../src/protection.js";
import { s3Client } from "../src/s3.js";
import { protectFlow } from "../src/flows/protect.js";
import { captured, scripted } from "./helpers.js";

// opts: { versioning: "Enabled" | "Suspended" | null, canDeleteVersions, locked: [prefixes] (R2) }
async function fakeS3(opts) {
  const objects = new Map(); // key -> [{ id, body, at, marker }], oldest first
  let n = 0;
  const xml = (status, code, res) => {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(`<Error><Code>${code}</Code></Error>`);
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const [, bucket, ...rest] = url.pathname.split("/").map(decodeURIComponent);
      const key = rest.join("/");
      const q = url.searchParams;
      const list = objects.get(key) ?? [];
      const current = list.at(-1);
      const exists = current && !current.marker;
      const locked = (opts.locked ?? []).some((pfx) => key.startsWith(pfx));
      const add = (version) => {
        const v = { id: opts.versioning === "Enabled" ? `v${++n}` : "null", at: new Date(Date.now()), ...version };
        if (opts.versioning !== "Enabled") objects.set(key, [v]);
        else objects.set(key, [...list, v]);
        return v;
      };
      if (req.method === "GET" && !key && q.has("versioning")) {
        res.end(`<VersioningConfiguration>${opts.versioning ? `<Status>${opts.versioning}</Status>` : ""}</VersioningConfiguration>`);
      } else if (req.method === "GET" && !key && q.has("versions")) {
        const parts = [];
        for (const [k, vs] of objects) {
          if (!k.startsWith(q.get("prefix") ?? "")) continue;
          vs.forEach((v, i) => {
            const t = v.marker ? "DeleteMarker" : "Version";
            const etag = v.marker ? "" : `<ETag>&quot;${createHash("md5").update(v.body).digest("hex")}&quot;</ETag>`;
            parts.push(
              `<${t}><Key>${k}</Key><VersionId>${v.id}</VersionId><IsLatest>${i === vs.length - 1}</IsLatest><LastModified>${v.at.toISOString()}</LastModified>${etag}</${t}>`,
            );
          });
        }
        res.end(`<ListVersionsResult><IsTruncated>false</IsTruncated>${parts.join("")}</ListVersionsResult>`);
      } else if (req.method === "GET" && !key) {
        const keys = [...objects].filter(([k, vs]) => k.startsWith(q.get("prefix") ?? "") && !vs.at(-1).marker).map(([k]) => k);
        res.end(
          `<ListBucketResult>${keys
            .slice(0, Number(q.get("max-keys") ?? 1000))
            .map((k) => `<Contents><Key>${k}</Key></Contents>`)
            .join("")}</ListBucketResult>`,
        );
      } else if (req.method === "GET") {
        if (!exists) return xml(404, "NoSuchKey", res);
        res.end(current.body);
      } else if (req.method === "PUT") {
        // R2: the lock is checked before If-None-Match (as Cloudflare documents).
        if (locked && exists) return xml(409, "ObjectLockedByBucketPolicy", res);
        if (req.headers["if-none-match"] === "*" && exists) return xml(412, "PreconditionFailed", res);
        const copy = req.headers["x-amz-copy-source"];
        let content = body;
        if (copy) {
          const src = new URL(copy, "http://x");
          const srcKey = decodeURIComponent(src.pathname).split("/").slice(2).join("/");
          content = objects.get(srcKey).find((v) => v.id === src.searchParams.get("versionId")).body;
        }
        const v = add({ body: content });
        res.writeHead(200, { "x-amz-version-id": v.id });
        res.end(copy ? "<CopyObjectResult/>" : "");
      } else if (req.method === "DELETE") {
        if (locked && exists) return xml(409, "ObjectLockedByBucketPolicy", res);
        if (q.has("versionId")) {
          if (!opts.canDeleteVersions) return xml(403, "AccessDenied", res);
          objects.set(
            key,
            list.filter((v) => v.id !== q.get("versionId")),
          );
        } else if (opts.versioning === "Enabled") add({ marker: true });
        else objects.delete(key);
        res.writeHead(204);
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, objects, close: () => server.close() };
}

async function setup(t, repository, opts) {
  const s3 = await fakeS3(opts);
  t.after(s3.close);
  process.env.AGOUTI_S3_ENDPOINT = s3.url;
  t.after(() => delete process.env.AGOUTI_S3_ENDPOINT);
  const root = await mkdtemp(join(tmpdir(), "agouti-protect-"));
  const p = paths({ AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") });
  await saveRecoveryKey("agouti-rk-TEST", p);
  await saveCredentials({ AWS_ACCESS_KEY_ID: "server", AWS_SECRET_ACCESS_KEY: "secret" }, p);
  const config = { repository, projects: {} };
  await saveConfig(config, p);
  const c = s3Client(repository, { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", AGOUTI_S3_ENDPOINT: s3.url });
  // A restic repository, as restic lays it out.
  const files = { config: "CONFIG", "keys/k1": "KEY", "snapshots/s1": "SNAP", "data/ab/abcd": "PACK", "index/i1": "IDX" };
  for (const [k, v] of Object.entries(files)) await c.request("PUT", c.full(k), { body: v });
  return { p, config, c, s3 };
}

const R2 = "s3:https://acc123.r2.cloudflarestorage.com/backups/agouti";
const AWS = "s3:https://s3.eu-west-1.amazonaws.com/backups/agouti";

test("which storage can be protected, and how", () => {
  assert.equal(protectionKind(R2), "r2");
  assert.equal(protectionKind(AWS), "versioning");
  assert.equal(protectionKind("s3:https://s3.eu-central-003.backblazeb2.com/b"), "versioning");
  assert.equal(protectionKind("sftp:u@h:/srv"), null);
  assert.equal(protectionKind("/mnt/backups"), null);
  assert.equal(provider("s3:https://s3.eu-central-003.backblazeb2.com/b"), "b2");
  const aws = versioningInstructions(AWS);
  assert.match(aws, /"Resource": "arn:aws:s3:::backups\/agouti\/\*"/);
  assert.match(aws, /"s3:DeleteObject"/);
  assert.doesNotMatch(aws, /DeleteObjectVersion|PutLifecycle|PutBucketVersioning/);
  assert.match(versioningInstructions("s3:https://s3.eu-central-003.backblazeb2.com/b"), /listBuckets,listFiles,readFiles,writeFiles$/m);
  assert.equal(parseWhen("2026-11-03 02:00").toISOString(), "2026-11-03T02:00:00.000Z");
  assert.throws(() => parseWhen("last tuesday"), /Not a time/);
});

test("R2: protected only if every folder restic keeps is locked, and locks/ isn't", async (t) => {
  const locked = ["agouti/config", "agouti/keys/", "agouti/snapshots/", "agouti/data/"];
  const { p, config, s3 } = await setup(t, R2, { locked });
  const r = await checkProtection(config, { p });
  assert.equal(r.protected, true, JSON.stringify(r.checks));
  assert.deepEqual(
    r.checks.map((c) => `${c.name}: ${c.detail}`),
    ["config: locked", "keys/: locked", "snapshots/: locked", "data/: locked", "locks/: open, as restic needs"],
  );
  assert.equal(s3.objects.get("agouti/config").at(-1).body, "CONFIG", "the checks change nothing");
  assert.equal(s3.objects.get("agouti/data/ab/abcd").length, 1);
});

test("R2: a missing rule is caught without touching the data", async (t) => {
  const { p, config, s3 } = await setup(t, R2, { locked: ["agouti/config", "agouti/keys/", "agouti/snapshots/"] });
  const r = await checkProtection(config, { p });
  assert.equal(r.protected, false);
  assert.deepEqual(
    r.checks.find((c) => c.name === "data/"),
    { name: "data/", ok: false, detail: "not locked: it could be deleted or overwritten" },
  );
  assert.equal(s3.objects.get("agouti/data/ab/abcd").at(-1).body, "PACK", "the probe didn't overwrite it");

  // A rule covering everything would also lock restic's lock files: backups would fail.
  const all = await setup(t, R2, { locked: ["agouti/"] });
  const r2 = await checkProtection(all.config, { p: all.p });
  assert.match(r2.checks.find((c) => c.name === "locks/").detail, /restic can't remove its lock files/);
});

test("R2: lock rules are added through the Cloudflare API, keeping the bucket's other rules", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body && JSON.parse(init.body) });
    const result = init.method === "GET" ? { rules: [{ id: "keep-logs", enabled: true, prefix: "logs/", condition: { type: "Indefinite" } }] } : null;
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  };
  await applyR2Locks({ repository: R2 }, " cf-token ", { fetchImpl });
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/acc123/r2/buckets/backups/lock");
  assert.equal(calls[0].auth, "Bearer cf-token");
  assert.deepEqual(
    calls[1].body.rules.map((r) => `${r.id} ${r.prefix ?? ""} ${r.condition.type}`),
    [
      "keep-logs logs/ Indefinite",
      "agouti-config agouti/config Indefinite",
      "agouti-keys agouti/keys/ Indefinite",
      "agouti-snapshots agouti/snapshots/ Indefinite",
      "agouti-data agouti/data/ Indefinite",
    ],
  );

  const refuse = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
  await assert.rejects(
    applyR2Locks({ repository: R2 }, "bad", { fetchImpl: refuse }),
    /Cloudflare refused to read the bucket lock rules: Authentication error/,
  );
});

test("versioning: protected only with versioning on and a key that can't delete versions", async (t) => {
  const good = await setup(t, AWS, { versioning: "Enabled", canDeleteVersions: false });
  const r = await checkProtection(good.config, { p: good.p });
  assert.equal(r.protected, true, JSON.stringify(r.checks));
  assert.deepEqual(
    r.checks.map((c) => c.detail),
    ["on: deleted or overwritten files keep their previous version", "can't delete old versions"],
  );

  const admin = await setup(t, AWS, { versioning: "Enabled", canDeleteVersions: true });
  assert.match((await checkProtection(admin.config, { p: admin.p })).checks[1].detail, /can delete old versions/);
  const off = await setup(t, AWS, { versioning: null, canDeleteVersions: false });
  assert.match((await checkProtection(off.config, { p: off.p })).checks[0].detail, /off: deleted files would be gone for good/);

  await saveProtection(good.config, r, { keepDays: 30, p: good.p });
  assert.deepEqual(Object.keys((await loadConfig(good.p)).protection), ["kind", "checkedAt", "keepDays"]);
});

test("rollback: undoes deletes, overwrites and additions, with the restricted key", async (t) => {
  const { p, config, c } = await setup(t, AWS, { versioning: "Enabled", canDeleteVersions: false });
  await new Promise((r) => setTimeout(r, 20));
  const before = new Date();
  await new Promise((r) => setTimeout(r, 20));
  // The attack.
  await c.request("PUT", c.full("config"), { body: "garbage" });
  await c.request("DELETE", c.full("snapshots/s1"));
  await c.request("DELETE", c.full("data/ab/abcd"));
  await c.request("PUT", c.full("snapshots/ransom"), { body: "pay us" });
  await c.request("PUT", c.full("locks/l1"), { body: "lock" });

  const plan = await rollback(config, before, { p, dryRun: true });
  assert.deepEqual(plan, { restored: 3, hidden: 1, unchanged: 2 }); // keys and index untouched
  assert.equal((await c.request("GET", c.full("config"))).body, "garbage", "a dry run changes nothing");

  await rollback(config, before, { p });
  const get = async (k) => (await c.request("GET", c.full(k))).body;
  assert.equal(await get("config"), "CONFIG");
  assert.equal(await get("snapshots/s1"), "SNAP");
  assert.equal(await get("data/ab/abcd"), "PACK");
  assert.equal((await c.request("GET", c.full("snapshots/ransom"))).status, 404, "added since: hidden");
  assert.equal(await get("locks/l1"), "lock", "restic's lock files are left alone");
  assert.deepEqual(await rollback(config, before, { p, dryRun: true }), { restored: 0, hidden: 0, unchanged: 6 }, "rolling back twice changes nothing");
});

test("interactive: rules added in the dashboard are checked before anything is saved", async (t) => {
  const { p } = await setup(t, R2, { locked: ["agouti/config", "agouti/keys/", "agouti/snapshots/"] }); // data/ forgotten
  const ask = scripted([
    ["select", /How do you want to add the rules/, "manual"],
    ["confirm", /Done/, true],
    ["select", /Not protected yet/, "later"],
  ]);
  const out = await captured(() => protectFlow(ask, { p }));
  assert.deepEqual(ask.remaining, []);
  assert.match(out, /prefix agouti\/data\//, "the rules to add are spelled out");
  assert.match(out, /✕ data\/ {7}not locked/);
  assert.match(out, /Not protected: an attacker on this server could still delete the backups/);
  assert.equal((await loadConfig(p)).protection, undefined, "nothing saved");
});

test("interactive: versioning with the same key, checked and saved", async (t) => {
  const { p } = await setup(t, AWS, { versioning: "Enabled", canDeleteVersions: false });
  const ask = scripted([["select", /Which key does this server use now/, "same"]]);
  const out = await captured(() => protectFlow(ask, { p }));
  assert.match(out, /Permanently delete noncurrent versions" after 30 days/);
  assert.match(out, /✓ key {9}can't delete old versions/);
  assert.match(out, /Append-only storage is in place/);
  assert.equal((await loadConfig(p)).protection.kind, "versioning");
});

test("SFTP and local storage: explained, not pretended", async (t) => {
  const { p } = await setup(t, AWS, {});
  const config = await loadConfig(p);
  config.repository = "sftp:backup@host:/srv/agouti";
  await saveConfig(config, p);
  await assert.rejects(
    captured(() => protectFlow(scripted([]), { p })),
    /can't be made append-only/,
  );
});
