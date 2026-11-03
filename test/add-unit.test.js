import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectApp, dirStats, fileCandidates, formatBytes, suggestName } from "../src/detect.js";
import { databaseSettingsFrom } from "../src/envfile.js";
import { backupUserSql, optionFileContent } from "../src/mysql.js";
import { validateFolders } from "../src/projects.js";
import { UserError } from "../src/ui.js";
import { ENV, laravelFixture } from "./helpers.js";

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

test("option file escapes the password and never needs the command line", () => {
  const txt = optionFileContent({ host: "127.0.0.1", port: 3306, username: "shop", password: 'a"b\\c #d' });
  assert.match(txt, /^\[client\]$/m);
  assert.match(txt, /^password="a\\"b\\\\c #d"$/m);
  assert.match(optionFileContent({ socket: "/run/mysqld/mysqld.sock", username: "u", password: "" }), /^socket=/m);
});

test("backup user SQL is read-only and quoted", () => {
  const sql = backupUserSql({ database: "shop`prod", password: "it's" });
  assert.match(sql, /IDENTIFIED BY 'it''s'/);
  assert.match(sql, /GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT ON `shop``prod`\.\*/);
  assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE|DROP|ALL PRIVILEGES/);
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

test("names and sizes", () => {
  assert.equal(suggestName("/var/www/My Shop"), "my-shop");
  assert.equal(formatBytes(2_100_000_000), "2.1 GB");
  assert.equal(formatBytes(640_000_000), "640 MB");
});
