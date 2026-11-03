// A small S3 client (AWS Signature V4), for what restic doesn't do: checking that
// the storage is append-only, and setting it up. Works with AWS S3, Cloudflare R2,
// Backblaze B2 and other S3-compatible storage. Path-style URLs throughout.
import { createHash, createHmac } from "node:crypto";
import { UserError } from "./ui.js";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
// RFC 3986, as SigV4 wants it.
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// "s3:https://host/bucket/prefix" + credentials -> a client.
export function s3Client(repository, env) {
  const m = String(repository).match(/^s3:(https?:\/\/[^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!m) throw new UserError(`Not an S3 repository: ${repository}`);
  const [, url, bucket, prefix = ""] = m;
  // Tests point requests at a local stand-in while keeping the real repository name.
  const endpoint = env.AGOUTI_S3_ENDPOINT || url;
  const host = new URL(endpoint).host;
  const named = new URL(url).host;
  const region =
    named.match(/^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/)?.[1] ??
    named.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/)?.[1] ??
    (named.endsWith(".r2.cloudflarestorage.com") ? "auto" : env.AWS_DEFAULT_REGION || env.AWS_REGION || "us-east-1");
  const creds = { id: env.AWS_ACCESS_KEY_ID, secret: env.AWS_SECRET_ACCESS_KEY };
  if (!creds.id || !creds.secret) throw new UserError("The storage keys (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) are missing.");

  // key: path inside the bucket. Returns { status, headers, body, code }.
  async function request(method, key = "", { query = {}, headers = {}, body = "" } = {}) {
    const path = `/${bucket}${key ? "/" + key.split("/").map(encode).join("/") : ""}`;
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${encode(k)}=${encode(query[k] ?? "")}`)
      .join("&");
    const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
    const day = now.slice(0, 8);
    const payloadHash = sha256(body);
    const extra = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const signed = { ...extra, host, "x-amz-content-sha256": payloadHash, "x-amz-date": now };
    const names = Object.keys(signed).sort();
    const canonical = [method, path, qs, names.map((n) => `${n}:${signed[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", now, scope, sha256(canonical)].join("\n");
    const key_ = hmac(hmac(hmac(hmac(`AWS4${creds.secret}`, day), region), "s3"), "aws4_request");
    const signature = createHmac("sha256", key_).update(toSign).digest("hex");
    const res = await fetch(`${endpoint}${path}${qs ? "?" + qs : ""}`, {
      method,
      headers: {
        ...extra,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": now,
        authorization: `AWS4-HMAC-SHA256 Credential=${creds.id}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
      },
      body: body || undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text, code: tag(text, "Code") };
  }

  const full = (k) => (prefix ? `${prefix.replace(/\/+$/, "")}/${k}` : k);

  return {
    bucket,
    prefix,
    host: named,
    region,
    full,
    request,
    // First object under a repository folder (e.g. "data/"), or null.
    async firstKey(dir) {
      const r = await request("GET", "", { query: { "list-type": "2", prefix: full(dir), "max-keys": "1" } });
      if (r.status !== 200) throw s3Error("list", r);
      return tag(r.body, "Key");
    },
    // Every version and delete marker under a repository folder ("" for all):
    // [{ key, versionId, lastModified: Date, latest, etag, deleteMarker }].
    async versions(dir = "") {
      const out = [];
      let marker = {};
      for (;;) {
        const r = await request("GET", "", { query: { versions: "", prefix: full(dir), ...marker } });
        if (r.status !== 200) throw s3Error("list the versions in", r);
        for (const [, type, xml] of r.body.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
          out.push({
            key: tag(xml, "Key"),
            versionId: tag(xml, "VersionId"),
            lastModified: new Date(tag(xml, "LastModified")),
            latest: tag(xml, "IsLatest") === "true",
            etag: tag(xml, "ETag"),
            deleteMarker: type === "DeleteMarker",
          });
        }
        if (tag(r.body, "IsTruncated") !== "true") return out;
        marker = { "key-marker": tag(r.body, "NextKeyMarker"), "version-id-marker": tag(r.body, "NextVersionIdMarker") };
      }
    },
    // Makes an old version the current one again (a copy onto itself).
    async restoreVersion(key, versionId) {
      const source = `/${bucket}/${key.split("/").map(encode).join("/")}?versionId=${encodeURIComponent(versionId)}`;
      const r = await request("PUT", key, { headers: { "x-amz-copy-source": source } });
      if (r.status !== 200) throw s3Error(`restore ${key} in`, r);
    },
    async versioning() {
      const r = await request("GET", "", { query: { versioning: "" } });
      if (r.status !== 200) throw s3Error("read the versioning setting of", r);
      return tag(r.body, "Status") ?? "Off";
    },
  };
}

export function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m
    ? m[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
    : null;
}

export function s3Error(what, r) {
  return new UserError(`Couldn't ${what} the bucket: HTTP ${r.status}${r.code ? ` ${r.code}` : ""}`);
}
