import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative } from "node:path";
import { test } from "node:test";
import { detectApp, dirStats, fileCandidates, findApps, formatBytes, suggestName } from "../src/detect.js";
import { databaseSettingsFrom } from "../src/envfile.js";
import { backupUserName, backupUserSql, clientFlavor, dumpClient, mysqlClient, optionFileContent } from "../src/mysql.js";
import { validateFolders } from "../src/projects.js";
import { UserError } from "../src/ui.js";
import { ENV, laravelFixture } from "./helpers.js";

test("backup user SQL: only the grant the server accepts, so a pasted script runs to the end", () => {
  const who = "'agouti_backup'@'localhost'";
  const statements = (flavor) => backupUserSql({ database: "d", username: "agouti_backup", password: "p", flavor }).split("\n").filter((l) => !l.startsWith("--")).join("\n");
  assert.ok(statements("mariadb").includes(`GRANT SELECT ON mysql.proc TO ${who};`));
  assert.ok(!statements("mariadb").includes("SHOW_ROUTINE"));
  assert.ok(statements("mysql").includes(`GRANT SHOW_ROUTINE ON *.* TO ${who};`));
  assert.ok(!statements("mysql").includes("mysql.proc"));
  assert.ok(!statements(null).includes("SHOW_ROUTINE") && !statements(null).includes("mysql.proc"));
  assert.match(backupUserSql({ database: "d", username: "agouti_backup", password: "p", flavor: null }), /MariaDB: +GRANT SELECT ON mysql.proc/);
});

test("backup user names: one per app, MySQL's 32-character limit, and no two apps sharing one", () => {
  assert.equal(backupUserName("shop"), "agouti_shop");
  assert.ok(backupUserName("school-management-inventory").length <= 32);
  assert.match(backupUserName("school-management-inventory"), /^agouti_school_management_[0-9a-f]{6}$/);
  assert.notEqual(backupUserName("school-management-inventory"), backupUserName("school-management-inventory-v2"), "long, similar names stay apart");
  assert.equal(backupUserName("school-management-inventory"), backupUserName("school-management-inventory"), "the same app always gets the same name");
  assert.match(backupUserName("a.b c"), /^agouti_a_b_c$/);
});

test("backup user SQL can be run again: a retry with a new password updates the user", () => {
  const sql = backupUserSql({ database: "d", username: "agouti_shop", password: "new", flavor: "mysql" });
  assert.match(sql, /^CREATE USER IF NOT EXISTS 'agouti_shop'@'localhost' IDENTIFIED BY 'new';\nALTER USER 'agouti_shop'@'localhost' IDENTIFIED BY 'new';/);
});

test("a server with only MariaDB's client names is still usable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agouti-clients-"));
  for (const name of ["mariadb", "mariadb-dump"]) {
    await writeFile(join(dir, name), "#!/bin/sh\necho 'mariadb from 11.4.5-MariaDB'\n");
    await chmod(join(dir, name), 0o755);
  }
  const saved = { PATH: process.env.PATH, AGOUTI_MYSQL: process.env.AGOUTI_MYSQL, AGOUTI_MYSQLDUMP: process.env.AGOUTI_MYSQLDUMP };
  delete process.env.AGOUTI_MYSQL;
  delete process.env.AGOUTI_MYSQLDUMP;
  process.env.PATH = dir;
  try {
    assert.equal(mysqlClient(), "mariadb");
    assert.equal(dumpClient(), "mariadb-dump");
    assert.equal(await clientFlavor(), "mariadb");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test(".env: only database settings come out, other secrets never do", () => {
  const s = databaseSettingsFrom(ENV);
  assert.deepEqual(s, {
    connection: "mysql",
    host: "127.0.0.1",
    port: 3307,
    socket: undefined,
    database: "shop_prod",
    username: "shop",
    password: 'p"a#ss word',
  });
  const everything = JSON.stringify(s);
  for (const secret of ["SUPERSECRETAPPKEY", "sk_live", "also-secret"]) assert.ok(!everything.includes(secret));
});

test(".env: DB_URL, unsupported engines and unresolved variables", () => {
  const u = databaseSettingsFrom("DB_URL=mysql://bob:s%40cret@db.internal:3310/app");
  assert.equal(u.host, "db.internal");
  assert.equal(u.port, 3310);
  assert.equal(u.password, "s@cret");
  assert.throws(() => databaseSettingsFrom("DB_CONNECTION=pgsql\nDB_DATABASE=x\nDB_USERNAME=y"), /supports MySQL and MariaDB/);
  assert.throws(() => databaseSettingsFrom("DB_CONNECTION=mysql\nDB_DATABASE=${APP}_db\nDB_USERNAME=y"), UserError);
  assert.throws(() => databaseSettingsFrom("APP_KEY=x"), /no database settings/);
});

test(".env of Node apps: DATABASE_URL (Prisma), DB_NAME/DB_USER/DB_PASS, mysql2", () => {
  const prisma = databaseSettingsFrom('NEXTAUTH_SECRET=hush\nDATABASE_URL="mysql://root@127.0.0.1:3306/maintenance_card?connection_limit=5"');
  assert.deepEqual([prisma.connection, prisma.host, prisma.port, prisma.database, prisma.username, prisma.password], ["mysql", "127.0.0.1", 3306, "maintenance_card", "root", ""]);
  assert.ok(!JSON.stringify(prisma).includes("hush"));
  const node = databaseSettingsFrom("PORT=8083\nDB_HOST=localhost\nDB_NAME=school_clinic\nDB_USER=clinic_app\nDB_PASS=pw\nDB_DIALECT=mysql2\nJWT_SECRET=x");
  assert.deepEqual([node.connection, node.database, node.username, node.password], ["mysql", "school_clinic", "clinic_app", "pw"]);
  assert.throws(() => databaseSettingsFrom("DATABASE_URL=postgresql://u@h/db"), /uses postgresql/);
  assert.throws(() => databaseSettingsFrom("DATABASE_URL=not a url"), /DATABASE_URL in .env isn't a valid URL/);
});

test("option file escapes the password and never needs the command line", () => {
  const txt = optionFileContent({ host: "127.0.0.1", port: 3306, username: "shop", password: 'a"b\\c #d' });
  assert.match(txt, /^\[client\]$/m);
  assert.match(txt, /^password="a\\"b\\\\c #d"$/m);
  assert.match(optionFileContent({ socket: "/run/mysqld/mysqld.sock", username: "u", password: "" }), /^socket=/m);
});

test("backup user SQL can't change data and is quoted", () => {
  const sql = backupUserSql({ database: "shop`prod", password: "it's" });
  assert.match(sql, /IDENTIFIED BY 'it''s'/);
  assert.match(sql, /GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON `shop``prod`\.\*/);
  assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE|DROP|ALL PRIVILEGES|LOCK TABLES/);
});

test("Laravel is detected and its upload folders offered, logs and cache excluded", async () => {
  const dir = await laravelFixture();
  const app = await detectApp(dir);
  assert.equal(app.framework, "laravel");
  assert.equal(app.label, "Laravel 11");
  assert.deepEqual(await fileCandidates(dir, "laravel"), [
    { path: "storage/app/private", include: true },
    { path: "storage/app/public", include: true },
    { path: "storage/logs", include: false, reason: "logs" },
    { path: "storage/framework", include: false, reason: "cache" },
    { path: "bootstrap/cache", include: false, reason: "cache" },
  ]);
  assert.deepEqual(await dirStats(join(dir, "storage/app")), { bytes: 2000, files: 2 });
  assert.equal((await detectApp(tmpdir())).framework, null);
});

test("folders must exist inside the app", async () => {
  const dir = await laravelFixture();
  assert.deepEqual(await validateFolders(dir, ["storage/app/public", " ./storage/app/public/ ", ""]), ["storage/app/public"]);
  await assert.rejects(validateFolders(dir, ["../etc"]), /inside/);
  await assert.rejects(validateFolders(dir, ["nope"]), /isn't an existing folder/);
});

test("a folder outside the app is given as a full path, and kept as one", async () => {
  const dir = await laravelFixture();
  const uploads = await mkdtemp(join(tmpdir(), "agouti-uploads-"));
  assert.deepEqual(await validateFolders(dir, ["storage/app/public", `${uploads}/`]), ["storage/app/public", uploads]);
  await assert.rejects(validateFolders(dir, [relative(dir, uploads)]), (e) => /isn't inside/.test(e.message) && /give its full path/.test(e.hint), "a ../ path is more likely a mistake");
  await assert.rejects(validateFolders(dir, [dirname(dir)]), /contains the app folder/, "the folder above would hold the code");
  await assert.rejects(validateFolders(dir, [parse(dir).root]), /contains the app folder/);
  await assert.rejects(validateFolders(dir, [dir]), /the app folder itself/);
  await assert.rejects(validateFolders(dir, [join(uploads, "nope")]), /isn't an existing folder/);
  // Inside the app, a full path is stored relative like the others.
  assert.deepEqual(await validateFolders(dir, [join(dir, "storage/app/private")]), ["storage/app/private"]);
  // One chosen inside another outside folder: only the outer one.
  await mkdir(join(uploads, "photos"));
  assert.deepEqual(await validateFolders(dir, [join(uploads, "photos"), uploads]), [uploads]);
});

test("Node and Next.js apps: detected from package.json, with their upload folders offered", async () => {
  const next = await mkdtemp(join(tmpdir(), "agouti-next-"));
  await writeFile(join(next, "package.json"), JSON.stringify({ dependencies: { next: "^14.2.3", react: "18" } }));
  for (const d of ["public/uploads/2026", "public/icons", "logs", "src", "node_modules/x"]) await mkdir(join(next, d), { recursive: true });
  await writeFile(join(next, ".env"), "DATABASE_URL=mysql://root@127.0.0.1/mc");
  assert.deepEqual(await detectApp(next), { framework: "nextjs", label: "Next.js 14", envFile: join(next, ".env") });
  assert.deepEqual(await fileCandidates(next, "nextjs"), [
    { path: "public/uploads", include: true },
    { path: "logs", include: false, reason: "logs" },
  ]);

  const node = await mkdtemp(join(tmpdir(), "agouti-node-"));
  await writeFile(join(node, "package.json"), JSON.stringify({ main: "server.js", dependencies: { express: "^4" } }));
  assert.deepEqual(await detectApp(node), { framework: "node", label: "Node.js app", envFile: null });
  assert.deepEqual(await fileCandidates(node, "node"), [], "nothing found: the uploads may be outside the app");

  // A package.json with nothing to run (a tooling file) isn't an app.
  const tooling = await mkdtemp(join(tmpdir(), "agouti-tooling-"));
  await writeFile(join(tooling, "package.json"), JSON.stringify({ name: "x" }));
  assert.equal((await detectApp(tooling)).framework, null);
});

test("apps are found one folder deeper when the top one isn't an app (project/backend)", async () => {
  const root = await mkdtemp(join(tmpdir(), "agouti-wwwroot-"));
  const laravel = await laravelFixture();
  await mkdir(join(root, "iso-cloud/frontend/dist"), { recursive: true });
  await rename(laravel, join(root, "iso-cloud/backend"));
  await mkdir(join(root, "shop"));
  await writeFile(join(root, "shop/package.json"), JSON.stringify({ scripts: { start: "node ." } }));
  await mkdir(join(root, "shop/node_modules/deep"), { recursive: true });
  await writeFile(join(root, "shop/node_modules/deep/package.json"), JSON.stringify({ main: "x.js" }));
  const found = await findApps([root]);
  assert.deepEqual(found.map((a) => [a.dir, a.framework]), [
    [join(root, "iso-cloud/backend"), "laravel"],
    [join(root, "shop"), "node"],
  ]);
  assert.equal(suggestName(join(root, "iso-cloud/backend")), "iso-cloud");
});

test("names and sizes", () => {
  assert.equal(suggestName("/var/www/My Shop"), "my-shop");
  assert.equal(formatBytes(2_100_000_000), "2.1 GB");
  assert.equal(formatBytes(640_000_000), "640 MB");
});

test("dirStats counts files whose names aren't valid UTF-8", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agouti-names-"));
  const sub = join(dir, "sub");
  await mkdir(sub);
  await writeFile(Buffer.concat([Buffer.from(`${sub}/caf`), Buffer.from([0xe9]), Buffer.from(".txt")]), "12345");
  await writeFile(join(sub, "normal.txt"), "123");
  assert.deepEqual(await dirStats(dir), { bytes: 8, files: 2 });
});

test("storage/app as a whole: chosen only when it has no disk folders, and never together with them", async () => {
  const dir = await laravelFixture();
  await writeFile(join(dir, "storage/app/leftover.txt"), "x");
  const whole = (await fileCandidates(dir, "laravel")).find((c) => c.path === "storage/app");
  assert.equal(whole.include, false, "with disks (public, private...), the whole folder isn't chosen for you");
  assert.equal(whole.whole, true);

  // Older Laravel: files directly in storage/app, no disk folders.
  const old = await mkdtemp(join(tmpdir(), "agouti-oldlaravel-"));
  await mkdir(join(old, "storage/app"), { recursive: true });
  await writeFile(join(old, "storage/app/invoice.pdf"), "x");
  assert.deepEqual((await fileCandidates(old, "laravel")).find((c) => c.path === "storage/app"), { path: "storage/app", include: true, note: "files directly inside" });

  // Both chosen: only the outer folder is kept.
  assert.deepEqual(await validateFolders(dir, ["storage/app/private", "storage/app", "storage/app/public"]), ["storage/app"]);
  assert.deepEqual(await validateFolders(dir, ["storage/app/public", "storage/app/private"]), ["storage/app/public", "storage/app/private"]);
});
