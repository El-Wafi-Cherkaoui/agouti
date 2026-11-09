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

// Unix file modes, /proc, bash quoting and sudo: Windows has its own tests (platform.test.js).
const LINUX_ONLY = { skip: process.platform === "win32" && "Linux only" };

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

test("config and credentials round-trip, secrets are private", LINUX_ONLY, async () => {
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

test("local storage on the system disk is flagged, other disks and remote storage aren't", LINUX_ONLY, () => {
  assert.match(localDiskWarning("/agouti-test-does-not-exist/repo"), /same disk/);
  assert.equal(localDiskWarning("/proc/agouti"), null); // a different filesystem
  assert.equal(localDiskWarning("s3:https://s3.eu-west-1.amazonaws.com/b"), null);
  assert.equal(localDiskWarning("sftp:u@h:/srv/b"), null);
});

test("shellQuote: printed commands read back exactly, whatever the file name", LINUX_ONLY, async () => {
  const { shellQuote } = await import("../src/ui.js");
  const { execFileSync } = await import("node:child_process");
  const names = ["/srv/shop/storage/app/a.pdf", "it's.pdf", "x'; rm -rf / #.pdf", "$(id) `id` $HOME.pdf", "new\nline.pdf", "esc\x1b[31mred.pdf", "back\\slash.pdf", "été ünïcode.pdf"];
  for (const name of names) {
    const q = shellQuote(name);
    assert.equal(execFileSync("bash", ["-c", `printf %s ${q}`]).toString(), name, q);
    assert.doesNotMatch(q, /[\x00-\x1f\x7f]/, "no raw control characters reach the terminal");
  }
});

test("suggested commands work under sudo: the full command when sudo can't find agouti (nvm, a git checkout)", LINUX_ONLY, async () => {
  const { setAgoutiCommand, withCommand, UserError } = await import("../src/ui.js");
  const { mkdtemp, writeFile, symlink, mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "agouti-cmd-"));
  const script = join(root, "nvm dir/agouti.js");
  await mkdir(join(root, "nvm dir"));
  await writeFile(script, "");
  try {
    // Not where sudo looks: the full command, quoted.
    assert.equal(setAgoutiCommand(script, { node: process.execPath, dirs: [join(root, "bin")] }), `sudo ${process.execPath} '${script}'`);
    assert.equal(withCommand("See them: sudo agouti restore shop --list"), `See them: sudo ${process.execPath} '${script}' restore shop --list`);
    assert.match(new UserError("x", "Run `sudo agouti verify --setup`").hint, /^Run `sudo .*agouti\.js' verify --setup`$/);
    // Installed where sudo looks (agouti and node both on its path): kept short.
    await mkdir(join(root, "bin"));
    await symlink(script, join(root, "bin/agouti"));
    await symlink(process.execPath, join(root, "bin/node"));
    assert.equal(setAgoutiCommand(script, { node: process.execPath, dirs: [join(root, "bin")] }), "sudo agouti");
    assert.equal(withCommand("sudo agouti verify"), "sudo agouti verify");
  } finally {
    setAgoutiCommand(script, { node: process.execPath, dirs: [join(root, "bin")] }); // short form: leaves other tests' text alone
  }
});

test("times in UTC get the server's local time next to them, from the system's rules, unless the server is on UTC", async () => {
  const { localNote } = await import("../src/ui.js");
  const saved = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo"; // read by `date`, the system's rules
    assert.equal(localNote("2026-11-08T23:30:00Z"), " (2026-11-09 08:30 local)", "the date when it's another day");
    assert.equal(localNote("2026-11-08T05:00:00Z"), " (14:00 local)");
    process.env.TZ = "UTC";
    assert.equal(localNote("2026-11-08T13:01:04Z"), "", "nothing to add on a UTC server");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
  assert.equal(localNote("2026-11-08T23:30:00Z", { timeZone: "Asia/Tokyo" }), " (2026-11-09 08:30 local)", "the fallback without `date`");
});
