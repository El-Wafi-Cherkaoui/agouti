// Child processes (restic, mysql...). Normally they share our process group, so
// Ctrl-C stops them with us. While shielded (during a restore), they get their own
// process group: a Ctrl-C or a dropped SSH session must not kill `mysql` halfway
// through loading a live database. The restore decides when to stop them.
import { spawn as nodeSpawn } from "node:child_process";

let shielded = false;
const running = new Set();

export function spawn(cmd, args, options = {}) {
  const child = nodeSpawn(cmd, args, { ...options, detached: shielded });
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
      process.kill(-child.pid, "SIGTERM"); // its whole process group
    } catch {}
  }
}
