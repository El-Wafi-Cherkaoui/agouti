// "Add an app", driven with scripted answers. A stand-in mysql client accepts any
// password except "wrong", and records its arguments.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { loadConfig, saveConfig } from "../src/config.js";
import { addFlow } from "../src/flows/add.js";
import { adminNotice, askAdmin, forgetAdminLogins } from "../src/flows/restore.js";
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
        assert.match(o.choices[0].name, /backup user that can't change your data \(recommended\)/);
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

test("backup user: SQL shown, failed connection fixed in place", async () => {
  const { p, dir } = await setup();
  const ask = scripted([
    ["input", /Name/, "shop"],
    ["select", /How should Agouti connect/, "backup-user"],
    ["input", /Database name/, "shop_prod"],
    ["select", /Create it how/, "sql"],
    ["select", /Done/, "yes"],
    ["select", /What now/, (o) => (assert.ok(o.choices.some((c) => c.value === "save")), "edit")],
    ["input", /Host/, (o) => (assert.equal(o.default, "localhost"), "localhost")],
    ["input", /Port/, "3306"],
    ["input", /Database name/, (o) => o.default],
    ["input", /Username/, (o) => (assert.equal(o.default, "agouti_shop", "one backup user per app"), o.default)],
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
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "mysql  Ver 8.4"; exit 0; fi\nif [ ! -f "${flaky}.ran" ]; then touch "${flaky}.ran"; echo "ERROR 1045 (28000): Access denied" >&2; exit 1; fi\nexec "${orig}" "$@"\n`,
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
  assert.match(out, /CREATE USER IF NOT EXISTS 'agouti_shop'@'localhost' IDENTIFIED BY '([^']+)';\nALTER USER 'agouti_shop'@'localhost' IDENTIFIED BY '\1';/, "running it again updates the user");
  const generated = out.match(/IDENTIFIED BY '([^']+)'/)[1];
  assert.match(out, /Couldn't connect: ERROR 1045/);

  const project = (await loadConfig(p)).projects.shop;
  assert.equal(project.database.user, "agouti_shop");
  assert.equal(project.database.source, "manual");
  assert.match(await readFile(project.database.credentials, "utf8"), new RegExp(`password="${generated}"`), "kept the generated password");
});

test("backup user created by Agouti: an admin login is asked once and kept nowhere", async () => {
  const { p, dir } = await setup();
  // A server where root has a password (Windows, most non-Debian servers), and no database "missing".
  const orig = process.env.AGOUTI_MYSQL;
  const server = join(await mkdtemp(join(tmpdir(), "agouti-server-")), "mysql");
  await writeFile(
    server,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "mysql  Ver 8.0.45"; exit 0; fi
file="\${1#--defaults-extra-file=}"
if grep -q 'user="root"' "$file" && grep -q 'password=""' "$file"; then echo "ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: NO)" >&2; exit 1; fi
case "$*" in *"SCHEMA_NAME = 'missing'"*) exit 0;; esac
exec "${orig}" "$@"
`,
  );
  await chmod(server, 0o755);
  process.env.AGOUTI_MYSQL = server;
  const admin = [
    ["input", /MySQL server/, (o) => (assert.equal(o.default, "localhost"), "localhost:3307")],
    ["input", /MySQL admin user/, "root"],
    ["password", /Password of root/, "r00t-secret"],
  ];
  const ask = scripted([
    ["input", /Name/, "shop"],
    ["select", /How should Agouti connect/, "backup-user"],
    ["input", /Database name/, "missing"],
    ["select", /Create it how/, "agouti"],
    ...admin,
    ["select", /How should Agouti connect/, "backup-user"],
    ["input", /Database name/, "shop_prod"],
    ["select", /Create it how/, "agouti"],
    // Asked once: the login is kept in memory for the rest of the session.
    ["checkbox", /Which folders/, ["storage/app/public"]],
    ["input", /Other folders/, ""],
    ["confirm", /Add shop/, true],
    ["confirm", /first backup/, false],
  ]);
  let out;
  try {
    out = await captured(() => addFlow(ask, { p, dir }));
  } finally {
    process.env.AGOUTI_MYSQL = orig;
  }
  assert.deepEqual(ask.remaining, []);
  assert.match(out, /This needs a MySQL admin that can create users/);
  assert.match(out, /How Agouti handles this password:[\s\S]*never saved[\s\S]*never appears on a command line/);
  assert.match(out, /Using the MySQL login root given earlier \(kept in memory until Agouti closes\)/);
  assert.match(out, /There's no database missing on this MySQL server/);
  assert.match(out, /Created agouti_shop: it can read shop_prod/);
  const args = await readFile(argsLog, "utf8");
  assert.match(args, /CREATE USER IF NOT EXISTS 'agouti_shop'@'localhost'/);
  assert.match(args, /GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON `shop_prod`\.\* TO 'agouti_shop'@'localhost'/);
  assert.ok(!args.includes("r00t-secret"), "the admin password is never on the command line");

  const project = (await loadConfig(p)).projects.shop;
  assert.equal(project.database.user, "agouti_shop");
  assert.equal(project.database.port, 3307, "the backup user connects to the server the admin gave");
  const cnf = await readFile(project.database.credentials, "utf8");
  assert.match(cnf, /user="agouti_shop"/);
  for (const f of [p.config, project.database.credentials]) assert.ok(!(await readFile(f, "utf8")).includes("r00t-secret"), `${f} holds the admin password`);
  assert.deepEqual((await readdir(p.dataDir).catch(() => [])).filter((f) => f.startsWith("restore-admin")), [], "no admin login file left behind");

  // Next time Agouti starts: server and user are filled in, the password is asked again.
  const defaults = await readFile(join(p.dataDir, "admin-login.json"), "utf8");
  assert.deepEqual(JSON.parse(defaults), { "local:3306": { server: "localhost:3307", user: "root" } });
  assert.ok(!defaults.includes("r00t-secret"), "the saved defaults hold no password");
  forgetAdminLogins();
  process.env.AGOUTI_MYSQL = server;
  const local = { database: { host: "localhost", port: 3306 } };
  // A restore says early on that the password will be needed...
  try {
    assert.match(await captured(() => adminNotice(local, p)), /Restoring the database will ask for a MySQL admin password/);
  } finally {
    process.env.AGOUTI_MYSQL = orig;
  }
  process.env.AGOUTI_MYSQL = server;
  const again = scripted([
    ["input", /MySQL server/, (o) => (assert.equal(o.default, "localhost:3307"), o.default)],
    ["input", /MySQL admin user/, (o) => (assert.equal(o.default, "root"), o.default)],
    ["password", /Password of root/, "r00t-secret"],
  ]);
  try {
    const login = await captured(() => askAdmin(again, local, p));
    assert.match(login, /How Agouti handles this password/);
    // ...but not once it's known in this session.
    assert.equal(await captured(() => adminNotice(local, p)), "");
  } finally {
    process.env.AGOUTI_MYSQL = orig;
  }
  assert.deepEqual(again.remaining, []);
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
