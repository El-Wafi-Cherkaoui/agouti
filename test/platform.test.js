// Windows rules, checked on any system (each helper takes the platform).
import assert from "node:assert/strict";
import test from "node:test";
import { escapePattern, fromSnapshotPath, relativePosix, toSnapshotPath } from "../src/platform.js";
import { includePattern } from "../src/names.js";
import { defaultDirs } from "../src/paths.js";
import { stdinPath } from "../src/restore.js";
import { splitWin, taskProgram, taskXml, winArg } from "../src/schedule.js";
import { shellQuote } from "../src/ui.js";

test("Windows paths become restic's snapshot paths and back", () => {
  assert.equal(toSnapshotPath("C:\\inetpub\\wwwroot\\shop\\storage\\app\\public", "win32"), "/C/inetpub/wwwroot/shop/storage/app/public");
  assert.equal(toSnapshotPath("c:\\shop\\", "win32"), "/C/shop");
  assert.equal(toSnapshotPath("C:\\", "win32"), "/C");
  assert.equal(fromSnapshotPath("/C/inetpub/shop/a b.pdf", "win32"), "C:\\inetpub\\shop\\a b.pdf");
  assert.equal(fromSnapshotPath("/D", "win32"), "D:\\");
  // Linux: unchanged.
  assert.equal(toSnapshotPath("/var/www/shop", "linux"), "/var/www/shop");
  assert.equal(fromSnapshotPath("/var/www/shop", "linux"), "/var/www/shop");
});

test("patterns: Linux escapes with \\, Windows (no escape character) with [ ]", () => {
  assert.equal(escapePattern("/srv/a[1]/*", "linux"), "/srv/a\\[1\\]/\\*");
  assert.equal(escapePattern("C:\\sites\\old [2]\\shop", "win32"), "C:/sites/old [[]2]/shop");
  assert.equal(includePattern("/storage/app/rapport[1].pdf", "win32"), "/storage/app/rapport[[]1].pdf");
  assert.equal(includePattern("\\storage\\app\\x.pdf", "win32"), "/storage/app/x.pdf");
});

test("folders are stored with / on Windows too", () => {
  assert.equal(relativePosix("C:\\inetpub\\shop", "C:\\inetpub\\shop\\storage\\app\\public", "win32"), "storage/app/public");
  assert.equal(relativePosix("/var/www/shop", "/var/www/shop/storage/app", "linux"), "storage/app");
});

test("Windows keeps Agouti's files in ProgramData", () => {
  assert.deepEqual(defaultDirs({ ProgramData: "C:\\ProgramData" }, "win32").configDir.split(/[\\/]/).slice(-2), ["Agouti", "config"]);
  assert.deepEqual(defaultDirs({}, "linux"), { configDir: "/etc/agouti", dataDir: "/var/lib/agouti" });
});

test("a database dump is /<db>.sql inside the snapshot, whatever restic lists", () => {
  assert.equal(stdinPath("C:\\shop.sql"), "/shop.sql");
  assert.equal(stdinPath("/shop.sql"), "/shop.sql");
});

test("commands for cmd.exe are double-quoted", () => {
  assert.equal(shellQuote("C:\\Program Files\\nodejs\\node.exe", "win32"), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(shellQuote("C:\\agouti\\bin\\agouti.js", "win32"), "C:\\agouti\\bin\\agouti.js");
});

test("the scheduled task runs this Node and Agouti, as SYSTEM, late if missed, output to a log", () => {
  const xml = taskXml("03:00", {
    command: ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\agouti\\bin\\agouti.js"],
    env: {},
    today: new Date(2026, 10, 9),
    log: "C:\\ProgramData\\Agouti\\data\\last-backup.log",
  });
  assert.match(xml, /<StartBoundary>2026-11-09T03:00:00<\/StartBoundary>/);
  assert.match(xml, /<UserId>S-1-5-18<\/UserId>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  const args = xml.match(/<Arguments>(.*)<\/Arguments>/)[1].replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  assert.equal(args, '/d /s /c ""C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\agouti\\bin\\agouti.js backup --scheduled > C:\\ProgramData\\Agouti\\data\\last-backup.log 2>&1"');
  assert.deepEqual(taskProgram(args), ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\agouti\\bin\\agouti.js"]);

  const custom = taskXml("23:30", { command: ["C:\\n.exe", "C:\\a b\\agouti.js"], env: { AGOUTI_CONFIG_DIR: "C:\\x y" }, log: "C:\\l.log" });
  const cargs = custom.match(/<Arguments>(.*)<\/Arguments>/)[1].replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  assert.match(cargs, /^\/d \/s \/c "set "AGOUTI_CONFIG_DIR=C:\\x y" && /);
  assert.deepEqual(taskProgram(cargs), ["C:\\n.exe", "C:\\a b\\agouti.js"]);
});

test("Windows argument quoting round-trips", () => {
  for (const a of ["plain", "C:\\Program Files\\x", 'say "hi"', "C:\\dir with space\\"]) assert.deepEqual(splitWin(winArg(a)), [a]);
});

test("a dump with Windows line endings (mysqldump.exe) is filtered like any other", async () => {
  const { dumpFilter } = await import("../src/dump.js");
  const dump = [
    "CREATE TABLE `items` (",
    "  `id` int NOT NULL",
    ");",
    "DELIMITER ;;",
    "/*!50106 CREATE*/ /*!50117 DEFINER=`root`@`localhost`*/ /*!50106 EVENT `purge` ON SCHEDULE EVERY 1 DAY DO DELETE FROM shop.items */ ;;",
    "DELIMITER ;",
    "INSERT INTO `items` VALUES (1);",
  ].join("\r\n");
  const f = dumpFilter({ skipEvents: true });
  const out = dump.split("\n").map((l) => f.line(l)).join("");
  assert.equal(f.stats.tables, 1);
  assert.equal(f.stats.events, 1);
  assert.equal(f.stats.skipped.events, 1);
  assert.doesNotMatch(out, /EVENT/);
  assert.doesNotMatch(out, /\r/);
});

test("suggested commands are rewritten in bold text too", async () => {
  const { setAgoutiCommand, withCommand } = await import("../src/ui.js");
  setAgoutiCommand(new URL("../bin/agouti.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), { platform: "win32" });
  assert.doesNotMatch(withCommand("Add one later: \x1b[1msudo agouti schedule\x1b[22m"), /sudo/);
  assert.equal(withCommand("pseudo agouti"), "pseudo agouti");
});

test("Windows: symbols cmd can't show are written plainly (all of them in logs, ⏎ in a terminal)", async () => {
  const { windowsText } = await import("../src/ui.js");
  assert.equal(windowsText("✓ database  2.1 KB dumped · 3.9s", { tty: false }), "ok database  2.1 KB dumped - 3.9s");
  assert.equal(windowsText("⚠ x → y ✕", { tty: false }), "! x -> y x");
  assert.equal(windowsText("contrat été.txt", { tty: false }), "contrat été.txt");
  assert.equal(windowsText("✓ ok · ⏎ submit", { tty: true }), "✓ ok · enter submit");
});

test("the command to look at a restored database uses the login the restore used", async () => {
  const { mysqlLookCommand } = await import("../src/flows/restore.js");
  assert.equal(mysqlLookCommand("shop_restored", { user: "root", host: "localhost", port: 3307 }, { windows: true, client: "mysql" }), "mysql -u root -p -P 3307 shop_restored");
  assert.equal(mysqlLookCommand("shop_restored", {}, { windows: true, client: "mysql" }), "mysql -u root -p shop_restored");
  assert.equal(mysqlLookCommand("shop_restored", {}, { windows: false, client: "mysql" }), "mysql shop_restored");
  assert.equal(mysqlLookCommand("x", { user: "admin", host: "db.lan", port: 3306 }, { windows: false, client: "mariadb" }), "mariadb -u admin -p -h db.lan x");
});
