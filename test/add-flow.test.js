// "Add an app", driven with scripted answers. A stand-in mysql client accepts any
// password except "wrong", and records its arguments.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { loadConfig, saveConfig } from "../src/config.js";
import { addFlow } from "../src/flows/add.js";
import { paths } from "../src/paths.js";
import { captured, laravelFixture, scripted } from "./helpers.js";

let argsLog;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "agouti-fakemysql-"));
  argsLog = join(dir, "args.log");
  const fake = join(dir, "mysql");
  await writeFile(
    fake,
    `#!/bin/sh
echo "$@" >> "${argsLog}"
file="\${1#--defaults-extra-file=}"
if grep -q 'password="wrong"' "$file"; then echo "ERROR 1045 (28000): Access denied for user" >&2; exit 1; fi
printf '8.0.40\\t62\\t48000000\\n'
`,
  );
  await chmod(fake, 0o755);
  process.env.AGOUTI_MYSQL = fake;
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agouti-add-"));
  const p = paths({ AGOUTI_CONFIG_DIR: join(root, "etc"), AGOUTI_DATA_DIR: join(root, "var") });
  await saveConfig({ repository: join(root, "repo"), projects: {} }, p);
  return { p, dir: await laravelFixture() };
}

test("reading .env: explained first, then only DB settings saved, password in a root-only file", async () => {
  const { p, dir } = await setup();
  const ask = scripted([
    ["input", /Name/, (o) => (assert.match(o.default, /^agouti-laravel-/), "shop")],
    [
      "select",
      /How should Agouti connect/,
      (o) => {
        assert.match(o.choices[0].name, /read-only backup user \(recommended\)/);
        return "env";
      },
    ],
    [
      "checkbox",
      /Which folders/,
      (o) => {
        const checked = o.choices.filter((c) => c.checked).map((c) => c.value);
        assert.deepEqual(checked, ["storage/app/private", "storage/app/public"]);
        return checked;
      },
    ],
    ["input", /Other folders/, ""],
    ["confirm", /Add shop/, true],
    ["confirm", /first backup/, false],
  ]);
  const out = await captured(() => addFlow(ask, { p, dir }));
  assert.deepEqual(ask.remaining, []);

  // The explanation came before the question, and covers what, where, how serious, what we suggest.
  assert.ok(out.indexOf("never stored") < out.indexOf("Connected:"));
  for (const phrase of [/APP_KEY/, /only the DB_\* lines/, /readable by root only/, /How serious is this/, /What we suggest/]) assert.match(out, phrase);
  assert.match(out, /Connected: MySQL 8\.0 · shop_prod · 62 tables · 48 MB/);

  const project = (await loadConfig(p)).projects.shop;
  assert.deepEqual(project.database, {
    engine: "mysql",
    name: "shop_prod",
    host: "127.0.0.1",
    port: 3307,
    user: "shop",
    credentials: join(p.projectsDir, "shop.cnf"),
    source: "env",
  });
  assert.deepEqual(project.files, ["storage/app/private", "storage/app/public"]);

  const yml = await readFile(p.config, "utf8");
  const cnf = await readFile(project.database.credentials, "utf8");
  assert.ok(!yml.includes("a#ss"), "password must not be in agouti.yml");
  assert.match(cnf, /password="p\\"a#ss word"/);
  assert.equal((await stat(project.database.credentials)).mode & 0o777, 0o600);
  for (const secret of ["SUPERSECRETAPPKEY", "sk_live", "also-secret"]) {
    assert.ok(!yml.includes(secret) && !cnf.includes(secret), `${secret} leaked`);
  }
  assert.ok(!(await readFile(argsLog, "utf8")).includes("a#ss"), "password must never be on the command line");
});

test("read-only backup user: SQL shown, failed connection fixed in place", async () => {
  const { p, dir } = await setup();
  const ask = scripted([
    ["input", /Name/, "shop"],
    ["select", /How should Agouti connect/, "backup-user"],
    ["input", /Database name/, "shop_prod"],
    ["select", /Done/, "yes"],
    ["select", /What now/, (o) => (assert.ok(o.choices.some((c) => c.value === "save")), "edit")],
    ["input", /Host/, (o) => (assert.equal(o.default, "localhost"), "localhost")],
    ["input", /Port/, "3306"],
    ["input", /Database name/, (o) => o.default],
    ["input", /Username/, (o) => (assert.equal(o.default, "agouti_backup"), o.default)],
    ["password", /leave empty to keep/, ""],
    ["checkbox", /Which folders/, ["storage/app/public"]],
    ["input", /Other folders/, ""],
    ["confirm", /Add shop/, true],
    ["confirm", /first backup/, false],
  ]);
  // Make the first attempt fail as if the SQL hadn't been run yet.
  const orig = process.env.AGOUTI_MYSQL;
  const flaky = join(await mkdtemp(join(tmpdir(), "agouti-flaky-")), "mysql");
  await writeFile(
    flaky,
    `#!/bin/sh\nif [ ! -f "${flaky}.ran" ]; then touch "${flaky}.ran"; echo "ERROR 1045 (28000): Access denied" >&2; exit 1; fi\nexec "${orig}" "$@"\n`,
  );
  await chmod(flaky, 0o755);
  process.env.AGOUTI_MYSQL = flaky;
  let out;
  try {
    out = await captured(() => addFlow(ask, { p, dir }));
  } finally {
    process.env.AGOUTI_MYSQL = orig;
  }
  assert.deepEqual(ask.remaining, []);
  assert.match(out, /CREATE USER 'agouti_backup'@'localhost' IDENTIFIED BY '([^']+)'/);
  const generated = out.match(/IDENTIFIED BY '([^']+)'/)[1];
  assert.match(out, /Couldn't connect: ERROR 1045/);

  const project = (await loadConfig(p)).projects.shop;
  assert.equal(project.database.user, "agouti_backup");
  assert.equal(project.database.source, "manual");
  assert.match(await readFile(project.database.credentials, "utf8"), new RegExp(`password="${generated}"`), "kept the generated password");
});

test("cancelling leaves nothing behind, and .env is never read", async () => {
  const { p, dir } = await setup();
  await chmod(join(dir, ".env"), 0o000); // reading it would now fail loudly (unless root)
  const ask = scripted([
    ["input", /Name/, "shop"],
    ["select", /How should Agouti connect/, "cancel"],
  ]);
  const out = await captured(() => addFlow(ask, { p, dir }));
  assert.match(out, /Nothing was saved/);
  assert.deepEqual((await loadConfig(p)).projects, {});
  await assert.rejects(stat(join(p.projectsDir, "shop.cnf")), { code: "ENOENT" });
});

test("the same directory or name can't be added twice", async () => {
  const { p, dir } = await setup();
  const add = () =>
    addFlow(
      scripted([
        ["input", /Name/, "shop"],
        ["select", /How/, "env"],
        ["checkbox", /Which/, []],
        ["input", /Other/, ""],
        ["confirm", /Add/, true],
        ["confirm", /first backup/, false],
      ]),
      { p, dir },
    );
  await captured(add);
  await assert.rejects(captured(add), /already added as "shop"/);
});
