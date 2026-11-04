// Leaving files out of backups, with real restic. The risks: a rule that empties a
// backup, a rule that silently does nothing, and a replace that deletes live files
// because they were left out of the snapshot.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { backupApps } from "../src/backup.js";
import { loadConfig, saveConfig, saveRecoveryKey } from "../src/config.js";
import { excludePatterns, restoreExcludes, validateExcludes } from "../src/excludes.js";
import { paths } from "../src/paths.js";
import { saveProject } from "../src/projects.js";
import { discoverApps, listPoints, restoreApp } from "../src/restore.js";
import { ensureRestic, resticEnv, run } from "../src/restic.js";
import { UserError } from "../src/ui.js";
import { installFakeMysql } from "./helpers.js";

const CACHE = fileURLToPath(new URL("./.cache", import.meta.url));
const FILES = ["up/keep.pdf", "up/thumbs/top.jpg", "up/a/thumbs/deep.jpg", "up/a/b/x.tmp", "up/a/b/y.pdf", "up/cache/c.bin", "docs/z.pdf", "docs/x.tmp"];
let restic;

before(async () => {
  try {
    restic = await ensureRestic({ p: paths({ AGOUTI_DATA_DIR: CACHE }) });
    process.env.AGOUTI_RESTIC = restic;
  } catch (err) {
    console.warn(`skipping exclude tests: ${err.message}`);
  }
  await installFakeMysql();
});

// appFolder lets a test put the app somewhere awkward.
async function setup(exclude, appFolder = "shop") {
  const root = await mkdtemp(join(tmpdir(), "agouti-exclude-"));
  process.env.FAKE_MYSQL_DATA = join(root, "mysql-data");
  const p = paths({ AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") });
  const repo = join(root, "repo");
  await saveRecoveryKey("agouti-rk-TEST", p);
  spawnSync(restic, ["init", "-r", repo, "--password-file", p.recoveryKey]);
  const dir = join(root, appFolder);
  for (const f of FILES) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), f);
  }
  const project = {
    path: dir,
    database: { engine: "mysql", name: "shop_prod", host: "127.0.0.1", port: 3306, user: "agouti_backup", credentials: join(root, "shop.cnf") },
    files: ["up", "docs"],
    exclude,
  };
  const config = { repository: repo, projects: { shop: project } };
  await saveConfig(config, p);
  return { root, p, dir, config };
}

async function backedUp({ p, config, dir }, point) {
  const env = await resticEnv(config, p);
  const [pt] = (await listPoints("shop", { bin: restic, env })).filter((x) => x.id === point);
  const ls = await run(restic, ["ls", "--json", pt.files.snapshot], { env });
  return ls.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((n) => n.type === "file")
    .map((n) => n.path.slice(dir.length + 1))
    .sort();
}

test("a path and a name leave out exactly what they say, at any depth", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const s = await setup(["up/cache", "thumbs", "*.tmp"]);
  const [r] = await backupApps([], { p: s.p });
  assert.equal(r.ok, true);
  assert.equal(r.files.warning, undefined);
  assert.deepEqual(await backedUp(s, r.point), ["docs/z.pdf", "up/a/b/y.pdf", "up/keep.pdf"]);
});

test("a name doesn't match the folders above the app (that would empty the backup)", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const s = await setup(["thumbs"], "thumbs");
  const [r] = await backupApps([], { p: s.p });
  assert.equal(r.ok, true);
  assert.ok((await backedUp(s, r.point)).includes("up/keep.pdf"));
});

test("special characters in the app's path don't break the rules", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const s = await setup(["up/cache", "thumbs"], "shop[1]*");
  const [r] = await backupApps([], { p: s.p });
  const got = await backedUp(s, r.point);
  assert.ok(!got.includes("up/cache/c.bin") && !got.includes("up/thumbs/top.jpg"));
  assert.ok(got.includes("up/keep.pdf"));
});

test("replace: excluded live files stay, other files go back to the restore point", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const s = await setup(["up/cache", "thumbs", "*.tmp"], "shop[1]");
  const [r] = await backupApps([], { p: s.p });
  await writeFile(join(s.dir, "up/thumbs/made-later.jpg"), "later");
  await writeFile(join(s.dir, "up/stray.txt"), "should be deleted");
  await writeFile(join(s.dir, "up/keep.pdf"), "damaged");

  const result = await restoreApp({ app: "shop", point: r.point, parts: ["files"], mode: "replace" }, { p: s.p });
  assert.equal(result.ok, true);

  for (const f of ["up/thumbs/top.jpg", "up/thumbs/made-later.jpg", "up/a/thumbs/deep.jpg", "up/cache/c.bin", "up/a/b/x.tmp", "docs/x.tmp"]) {
    assert.ok(existsSync(join(s.dir, f)), `${f} was deleted by the replace`);
  }
  assert.ok(!existsSync(join(s.dir, "up/stray.txt")), "a file that isn't excluded should still be deleted");
  assert.equal(await readFile(join(s.dir, "up/keep.pdf"), "utf8"), "up/keep.pdf");
});

test("replace goes by the rules the restore point was made with, not today's", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const s = await setup([]);
  const [r] = await backupApps([], { p: s.p });
  const config = await loadConfig(s.p);
  config.projects.shop.exclude = ["thumbs"];
  await saveConfig(config, s.p);
  await writeFile(join(s.dir, "up/thumbs/top.jpg"), "damaged");
  await restoreApp({ app: "shop", point: r.point, parts: ["files"], mode: "replace" }, { p: s.p });
  assert.equal(await readFile(join(s.dir, "up/thumbs/top.jpg"), "utf8"), "up/thumbs/top.jpg");
});

test("a rule that can't be applied is ignored and reported: everything is still backed up", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const s = await setup(["up", "../secrets", "/etc/x", "other/folder", "*", "up/*", 7]);
  const [r] = await backupApps([], { p: s.p });
  assert.equal(r.ok, true);
  assert.equal((await backedUp(s, r.point)).length, FILES.length);
  for (const bad of ['"up"', '"../secrets"', '"/etc/x"', '"other/folder"', '"\\*"', '"up/\\*"', '"7"']) assert.match(r.files.warning, new RegExp(bad));
});

test("rules that leave out every file fail loudly, instead of saving an empty backup", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const s = await setup(["?*"]);
  const [r] = await backupApps([], { p: s.p });
  assert.equal(r.ok, false);
  assert.match(r.files.error, /left out every file/);
});

test("a new server gets the app's rules back, and keeps them", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const s = await setup(["thumbs", "up/cache"]);
  await backupApps([], { p: s.p });
  const [found] = await discoverApps({ bin: restic, env: await resticEnv(s.config, s.p) });
  assert.deepEqual(found.description.exclude, ["thumbs", "up/cache"]);

  const db = { host: "127.0.0.1", port: 3306, database: "d", username: "u" };
  const root = await mkdtemp(join(tmpdir(), "agouti-exclude-new-"));
  const p = paths({ AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") });
  await saveConfig({ repository: "x", projects: {} }, p);
  const saved = await saveProject({ name: "shop", dir: "/srv/shop", db, source: "restored", files: found.description.files, exclude: found.description.exclude }, p);
  assert.deepEqual(saved.exclude, ["thumbs", "up/cache"]);
});

test("agouti add refuses a rule it can't apply, and tidies good ones", () => {
  assert.deepEqual(validateExcludes(["thumbs", " ./up/cache/ ", "", "thumbs"], ["up"]), ["thumbs", "up/cache"]);
  for (const bad of ["up", "/abs", "../x", "elsewhere/x", "*", "up/**"]) {
    assert.throws(() => validateExcludes([bad], ["up"]), UserError, bad);
  }
});

test("patterns: anchored, escaped, and rewritten for a restore of one folder", () => {
  const project = { path: "/srv/a[1]", files: ["up/", "docs"], exclude: ["thumbs", "up/cache/"] };
  const { patterns, ignored } = excludePatterns(project);
  assert.deepEqual(ignored, []);
  assert.deepEqual(patterns, ["/srv/a\\[1\\]/up/**/thumbs", "/srv/a\\[1\\]/docs/**/thumbs", "/srv/a\\[1\\]/up/cache"]);
  assert.deepEqual(restoreExcludes(patterns, "/srv/a[1]/up"), ["/**/thumbs", "/cache"]);
  assert.deepEqual(restoreExcludes(undefined, "/srv/x"), []);
});
