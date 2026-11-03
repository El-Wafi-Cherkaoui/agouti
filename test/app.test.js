// Drives the interactive app with scripted answers instead of a keyboard.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { app } from "../src/app.js";
import { paths } from "../src/paths.js";
import { askStorage } from "../src/prompts.js";
import { ensureRestic } from "../src/restic.js";
import { localDiskWarning } from "../src/storage.js";
import { captured, scripted } from "./helpers.js";

const CACHE = fileURLToPath(new URL("./.cache", import.meta.url));
let restic;

before(async () => {
  try {
    restic = await ensureRestic({ p: paths({ AGOUTI_DATA_DIR: CACHE }) });
    process.env.AGOUTI_RESTIC = restic;
  } catch (err) {
    console.warn(`skipping app tests: ${err.message}`);
  }
});

// Temp dirs are usually on the system disk, which triggers the local-storage warning.
const confirmIfSystemDisk = (dir) => (localDiskWarning(dir) ? [["confirm", /Use this directory anyway/, true]] : []);

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "agouti-app-"));
  return { root, p: paths({ AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") }), repo: join(root, "repo") };
}

test("fresh server: guided setup, insists on saving the key, then the home screen", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const { p, repo } = await sandbox();
  const ask = scripted([
    ["select", /new setup/, "create"],
    ["select", /Where should backups go/, "local"],
    ["input", /Directory/, repo],
    ...confirmIfSystemDisk(repo),
    ["confirm", /saved the recovery key/, false],
    ["confirm", /saved the recovery key/, true],
    ["confirm", /Add your first app now/, false],
    [
      "select",
      /What do you want to do/,
      (opts) => {
        const value = (v) => opts.choices.find((c) => c.value === v);
        assert.equal(value("backup"), undefined, "nothing to back up before an app is added");
        assert.ok(!value("add").disabled);
        assert.ok(value("restore"), "restore is offered: the backups may hold apps (new server)");
        return "check";
      },
    ],
    ["select", /What do you want to do/, "key"],
    ["confirm", /Show the recovery key/, true],
    ["select", /What do you want to do/, "quit"],
  ]);

  const out = await captured(() => app({ ask, p }));
  assert.deepEqual(ask.remaining, []);
  const key = out.match(/agouti-rk-[0-9A-Z-]+/)[0];
  assert.match(out, /Please do\. It's the only way/);
  assert.match(out, /0 apps · repo: local/);
  assert.match(out, /Storage reachable · 0 restore points/);
  assert.equal((await readFile(p.recoveryKey, "utf8")).trim(), key);
  assert.equal(out.split(key).length - 1, 3, "key shown at creation, at the reminder and on request");
});

test("new server: connect, recover from a wrong key without restarting", async (t) => {
  if (!restic) return t.skip("restic unavailable");
  const first = await sandbox();
  const setupOut = await captured(() =>
    app({
      p: first.p,
      ask: scripted([
        ["select", /new setup/, "create"],
        ["select", /Where/, "local"],
        ["input", /Directory/, first.repo],
        ...confirmIfSystemDisk(first.repo),
        ["confirm", /saved/, true],
        ["confirm", /Add your first app now/, false],
        ["select", /What do you want to do/, "quit"],
      ]),
    }),
  );
  const key = setupOut.match(/agouti-rk-[0-9A-Z-]+/)[0];

  const { p } = await sandbox();
  const ask = scripted([
    ["select", /new setup/, "connect"],
    ["select", /Where/, "local"],
    ["input", /Directory/, first.repo],
    ["password", /Recovery key/, "agouti-rk-NOPE"],
    ["select", /What now/, "retry"],
    ["select", /new setup/, "connect"],
    ["select", /Where/, "local"],
    ["input", /Directory/, first.repo],
    ["password", /Recovery key/, ` ${key.toLowerCase()} `],
    ["select", /What do you want to do/, "quit"],
  ]);
  const out = await captured(() => app({ ask, p }));
  assert.deepEqual(ask.remaining, []);
  assert.match(out, /doesn't open this repository/);
  assert.match(out, /Connected to local/);
});

test("storage questions: a mistake is asked again with answers prefilled", async () => {
  const ask = scripted([
    ["select", /Where/, "s3"],
    ["input", /Region/, "europe"],
    ["input", /Bucket/, "my-backups"],
    ["input", /Folder/, ""],
    ["input", /Access key/, "AK"],
    ["password", /Secret/, "SK"],
    ["select", /Where/, (o) => (assert.equal(o.default, "s3"), "s3")],
    ["input", /Region/, (o) => (assert.equal(o.default, "europe"), "eu-west-3")],
    ["input", /Bucket/, (o) => o.default],
    ["input", /Folder/, ""],
    ["input", /Access key/, (o) => o.default],
    ["password", /Secret/, "SK"],
  ]);
  let result;
  const out = await captured(async () => (result = await askStorage(ask)));
  assert.match(out, /doesn't look like an AWS region/);
  assert.equal(result.repository, "s3:https://s3.eu-west-3.amazonaws.com/my-backups");
  assert.equal(result.env.AWS_ACCESS_KEY_ID, "AK");
});

test("local storage on the system disk: warned, and 'No' goes back to the storage choice", async () => {
  const ask = scripted([
    ["select", /Where/, "local"],
    ["input", /Directory/, "/agouti-test-does-not-exist"],
    ["confirm", /Use this directory anyway/, false],
    ["select", /Where/, (o) => (assert.equal(o.default, "local"), "local")],
    ["input", /Directory/, (o) => (assert.equal(o.default, "/agouti-test-does-not-exist"), "/proc/agouti")],
  ]);
  let result;
  const out = await captured(async () => (result = await askStorage(ask, { warnLocal: true })));
  assert.deepEqual(ask.remaining, []);
  assert.match(out, /same disk as this server's system/);
  assert.equal(result.repository, "/proc/agouti");
});
