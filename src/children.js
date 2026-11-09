// Child processes (restic, mysql...). Normally they share our process group, so
// Ctrl-C stops them with us. While shielded (during a restore), they get their own
// process group: a Ctrl-C or a dropped SSH session must not kill `mysql` halfway
// through loading a live database. The restore decides when to stop them.
//
// Windows: detached gives the child its own process group and no console, so the
// console's Ctrl-C doesn't reach it either; windowsHide keeps it from opening a window.
import { spawn as nodeSpawn, spawnSync } from "node:child_process";

let shielded = false;
const running = new Set();

export function spawn(cmd, args, options = {}) {
  const child = nodeSpawn(cmd, args, { windowsHide: true, ...options, detached: shielded });
  if (shielded) {
    running.add(child);
    child.on("close", () => running.delete(child));
    child.on("error", () => running.delete(child));
  }
  return child;
}

export function shield(on) {
  shielded = on;
}

export function stopAll() {
  for (const child of running) {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else process.kill(-child.pid, "SIGTERM"); // its whole process group
    } catch {}
  }
}
