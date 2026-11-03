// End-to-end: runs the real CLI against a local restic repository.
// Needs internet the first time (downloads the pinned restic into test/.cache).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { paths } from "../src/paths.js";
import { ensureRestic } from "../src/restic.js";
import { localDiskWarning } from "../src/storage.js";

const BIN = fileURLToPath(new URL("../bin/agouti.js", import.meta.url));
const CACHE = fileURLToPath(new URL("./.cache", import.meta.url));
let restic;

before(async () => {
  try {
    restic = await ensureRestic({ p: paths({ AGOUTI_DATA_DIR: CACHE }) });
  } catch (err) {
    console.warn(`skipping CLI tests: ${err.message}`);
  }
});

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "agouti-e2e-"));
  const env = { ...process.env, AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var"), AGOUTI_RESTIC: restic, NO_COLOR: "1" };
  const agouti = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { root, env, agouti, repo: join(root, "repo") };
}

test("help and version", async () => {
  const { agouti } = await sandbox();
  assert.match(agouti("--help").stdout, /init\s+Create the encrypted backup repository/);
  assert.match(agouti("--version").stdout, /^\d+\.\d+\.\d+/);
  const bad = agouti("frobnicate");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown command: frobnicate/);
});

test("init creates a repository; connect opens it with the recovery key", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const a = await sandbox();

  const r = a.agouti("init", "--repo", a.repo);
  assert.equal(r.status, 0, r.stderr);
  if (localDiskWarning(a.repo)) assert.match(r.stdout, /same disk as this server's system/);
  const key = r.stdout.match(/agouti-rk-[0-9A-Z-]+/)?.[0];
  assert.ok(key, r.stdout);
  assert.match(await readFile(join(a.root, "etc/agouti.yml"), "utf8"), new RegExp(`repository: ${a.repo}`));
  assert.equal((await stat(join(a.root, "etc/recovery-key"))).mode & 0o777, 0o600);

  // A second init must not touch the existing setup.
  const again = a.agouti("init", "--repo", a.repo);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already uses a repository/);

  // A "new server" pointing init at the same storage is told to connect instead.
  const b = await sandbox();
  const clash = b.agouti("init", "--repo", a.repo);
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /already a backup repository/);

  const wrong = b.agouti("connect", a.repo, "--recovery-key", "agouti-rk-WRNG");
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /doesn't open this repository/);
  await assert.rejects(stat(join(b.root, "etc/recovery-key")), { code: "ENOENT" });

  const c = b.agouti("connect", a.repo, "--recovery-key", key.toLowerCase());
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /Connected to local/);
});

test("connect reports a missing repository", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const a = await sandbox();
  const r = a.agouti("connect", join(a.root, "nothing-here"), "--recovery-key", "agouti-rk-X");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no repository at/);
});
