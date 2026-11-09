// The app's service: found from NSSM settings, stopped and started around a replace,
// and whether its account can write into restored folders (Windows permissions).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { accountSids, canWrite, checkWriteAccess, findServices, grantAccess, servicesFor, validateServiceName } from "../src/services.js";

const NS = "S-1-5-20";

test("services: NSSM's AppDirectory or a wrapper .exe in the app folder, not other services", () => {
  const all = [
    { name: "SchoolClinic", display: "School Clinic", account: "NT AUTHORITY\\NetworkService", state: "Running", path: "C:\\inetpub\\wwwroot\\school-clinic\\scripts\\nssm.exe", appDirectory: "C:\\inetpub\\wwwroot\\school-clinic" },
    { name: "MaintenanceCard", account: "LocalSystem", state: "Running", path: "C:\\inetpub\\wwwroot\\maintenance-card\\nssm.exe", appDirectory: "C:\\inetpub\\wwwroot\\maintenance-card" },
    { name: "WinswApp", account: "LocalSystem", state: "Stopped", path: '"C:\\Apps\\Shop\\daemon\\shop.exe" //RS', appDirectory: null },
    { name: "Spooler", account: "LocalSystem", state: "Running", path: "C:\\Windows\\System32\\spoolsv.exe" },
    { name: "Broken", state: "Running" },
  ];
  // servicesFor compares with the system's own path rules; on Linux the Windows
  // paths are plain text, so the comparison is checked on lowercase forward forms.
  const posix = (s) => ({ ...s, path: s.path?.replace(/\\/g, "/"), appDirectory: s.appDirectory?.replace(/\\/g, "/") });
  const win = (dir) => servicesFor(dir.replace(/\\/g, "/"), all.map(posix));
  assert.deepEqual(win("C:\\inetpub\\wwwroot\\school-clinic"), [{ name: "SchoolClinic", display: "School Clinic", account: "NT AUTHORITY\\NetworkService", running: true }]);
  assert.deepEqual(win("C:\\INETPUB\\wwwroot\\maintenance-card").map((s) => s.name), ["MaintenanceCard"], "case doesn't matter on Windows");
  assert.deepEqual(win("C:\\Apps\\Shop").map((s) => [s.name, s.running]), [["WinswApp", false]], "a quoted .exe path with arguments");
  assert.deepEqual(win("C:\\inetpub\\wwwroot\\iso-cloud\\backend"), []);
  assert.equal(validateServiceName("SchoolClinic"), true);
  assert.equal(validateServiceName("shop-queue@1.service"), true);
  assert.notEqual(validateServiceName("x; Remove-Item C:\\"), true);
});

test("service accounts: their own SID and the groups every service has; other users aren't guessed", () => {
  assert.deepEqual(accountSids("NT AUTHORITY\\NetworkService"), [NS, "S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-5-6"]);
  assert.equal(accountSids("LocalSystem")[0], "S-1-5-18");
  assert.ok(accountSids("LocalSystem").includes("S-1-5-32-544"), "SYSTEM counts as an administrator");
  assert.equal(accountSids(".\\clinicapp"), null);
  assert.equal(accountSids(undefined), null);
});

// SRV3's C:\SchoolClinic\data\uploads (icacls, 2026-11-09), as Get-Acl writes it.
const SRV3 = "O:BAG:SYD:AI(A;OICI;0x1301bf;;;NS)(A;OICIID;0x1301bf;;;AU)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;WD)(A;OICIID;0x1200a9;;;BU)";

test("write access, read from the folder's permissions", () => {
  const ns = accountSids("NT AUTHORITY\\NetworkService");
  assert.equal(canWrite(SRV3, ns), true);
  // Tightened as we'd suggest: only SYSTEM, Administrators and NetworkService.
  assert.equal(canWrite("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;NS)", ns), true);
  // ...and then restored without the NetworkService entry: Users can only read.
  assert.equal(canWrite("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)", ns), false);
  // By full SID too, as Get-Acl writes an account it has no short name for.
  assert.equal(canWrite("D:(A;OICI;0x1301bf;;;S-1-5-20)", ns), true);
  // A deny entry wins.
  assert.equal(canWrite(`D:AI(D;OICI;0x2;;;NS)${SRV3.slice(SRV3.indexOf("("))}`, ns), false);
  // Only on files inside (inherit-only), or only on the folder: not enough to save uploads.
  assert.equal(canWrite("D:(A;OICIIO;0x1301bf;;;NS)", ns), false);
  assert.equal(canWrite("D:(A;;0x1301bf;;;NS)", ns), false);
  // Combined: one entry for the folder, another for its files.
  assert.equal(canWrite("D:(A;;0x1301bf;;;NS)(A;OIIO;0x1301bf;;;NS)", ns), true);
  // Generic write.
  assert.equal(canWrite("D:(A;OICI;GA;;;AU)", ns), true);
  // SACL after the DACL isn't read as permissions.
  assert.equal(canWrite("D:(A;OICI;0x1200a9;;;NS)S:(AU;SA;0x1301bf;;;NS)", ns), false);
});

// On a real Windows (CI): Get-Acl's SDDL as Windows writes it, and the fix with icacls.
test("Windows: a folder NetworkService can't write into is found, and fixed", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agouti-acl-"));
  // Only SYSTEM and Administrators, as after tightening a parent and losing the entry.
  const r = spawnSync("icacls", [dir, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const [before] = await checkWriteAccess([dir], "NT AUTHORITY\\NetworkService");
  assert.equal(before.ok, false);
  assert.match(before.fix, /icacls ".*" \/grant "\*S-1-5-20:\(OI\)\(CI\)M"/);
  grantAccess(dir, NS);
  assert.deepEqual(await checkWriteAccess([dir], "NT AUTHORITY\\NetworkService"), [{ folder: dir, ok: true }]);
  assert.deepEqual(await checkWriteAccess([dir], "LocalSystem"), [{ folder: dir, ok: true }]);
  assert.deepEqual(await findServices(dir), [], "no service runs from a new folder");
});
