import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, loadCredentials, saveConfig, saveCredentials } from "../src/config.js";
import { paths } from "../src/paths.js";
import { generateRecoveryKey, normalizeRecoveryKey } from "../src/recovery-key.js";
import { buildRepository, describeRepository, localDiskWarning } from "../src/storage.js";
import { UserError } from "../src/ui.js";

test("recovery keys have the documented shape and don't repeat", () => {
  const a = generateRecoveryKey();
  assert.match(a, /^agouti-rk-([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.notEqual(a, generateRecoveryKey());
});

test("recovery keys survive sloppy pasting", () => {
  const k = generateRecoveryKey();
  assert.equal(normalizeRecoveryKey(`  ${k.toLowerCase()}\n`), k);
});

test("storage providers build restic repository strings", () => {
  const keys = { accessKey: "AK", secretKey: "SK" };
  const r2 = buildRepository({ provider: "r2", accountId: "0123456789abcdef0123456789ABCDEF", bucket: "backups", prefix: "/srv1/", ...keys });
  assert.equal(r2.repository, "s3:https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/backups/srv1");
  assert.deepEqual(r2.env, { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_DEFAULT_REGION: "auto" });

  assert.equal(buildRepository({ provider: "s3", region: "eu-west-1", bucket: "b-1", ...keys }).repository, "s3:https://s3.eu-west-1.amazonaws.com/b-1");
  assert.equal(buildRepository({ provider: "b2", region: "us-west-004", bucket: "bkp", ...keys }).repository, "s3:https://s3.us-west-004.backblazeb2.com/bkp");
  assert.equal(
    buildRepository({ provider: "s3-compatible", endpoint: "minio.local:9000/", bucket: "bkp", ...keys }).repository,
    "s3:https://minio.local:9000/bkp",
  );
  assert.deepEqual(buildRepository({ provider: "sftp", sftpTarget: "u@h:/srv/b" }), { repository: "sftp:u@h:/srv/b", env: {} });
  assert.equal(buildRepository({ provider: "local", path: "/mnt/b" }).repository, "/mnt/b");
});

test("storage input is validated", () => {
  assert.throws(() => buildRepository({ provider: "r2", accountId: "nope", bucket: "b" }), UserError);
  assert.throws(() => buildRepository({ provider: "s3", region: "eu-west-1", bucket: "Bad_Bucket" }), UserError);
  assert.throws(() => buildRepository({ provider: "sftp", sftpTarget: "host-only" }), UserError);
});

test("repositories are described briefly", () => {
  assert.equal(describeRepository("s3:https://abc.r2.cloudflarestorage.com/b"), "R2");
  assert.equal(describeRepository("sftp:u@h:/x"), "SFTP (u@h)");
  assert.equal(describeRepository("/mnt/b"), "local (/mnt/b)");
});

test("config and credentials round-trip, secrets are private", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agouti-test-"));
  const p = paths({ AGOUTI_CONFIG_DIR: dir, AGOUTI_DATA_DIR: dir });

  assert.equal(await loadConfig(p), null);
  await saveConfig({ repository: "/mnt/b", projects: { shop: { path: "/var/www/shop" } } }, p);
  assert.deepEqual(await loadConfig(p), { repository: "/mnt/b", projects: { shop: { path: "/var/www/shop" } } });
  assert.match(await readFile(p.config, "utf8"), /^# Agouti configuration/);

  const creds = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: 's3cr"et=/+' };
  await saveCredentials(creds, p);
  assert.deepEqual(await loadCredentials(p), creds);
  assert.equal((await stat(p.credentials)).mode & 0o777, 0o600);
});

test("local storage on the system disk is flagged, other disks and remote storage aren't", () => {
  assert.match(localDiskWarning("/agouti-test-does-not-exist/repo"), /same disk/);
  assert.equal(localDiskWarning("/proc/agouti"), null); // a different filesystem
  assert.equal(localDiskWarning("s3:https://s3.eu-west-1.amazonaws.com/b"), null);
  assert.equal(localDiskWarning("sftp:u@h:/srv/b"), null);
});
