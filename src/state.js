// What Agouti remembers between runs (last backup per app), and a lock so two
// backups never run at the same time (say, the nightly timer and a manual run).
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fsError, writeAtomic } from "./config.js";
import { paths } from "./paths.js";
import { UserError } from "./ui.js";

const stateFile = (p) => join(p.dataDir, "state.json");
export const lockFile = (p) => join(p.dataDir, "backup.lock");

export async function loadState(p = paths()) {
  try {
    const s = JSON.parse(await readFile(stateFile(p), "utf8"));
    s.projects ??= {};
    return s;
  } catch (err) {
    if (err.code === "ENOENT" || err instanceof SyntaxError) return { projects: {} };
    throw fsError(err, stateFile(p));
  }
}

// Keeps the latest result, and the latest successful one, so "failed 6h ago,
// last good backup 2 days ago" can be shown.
export async function recordBackup(name, result, p = paths()) {
  const state = await loadState(p);
  const prev = state.projects[name] ?? {};
  state.projects[name] = { ...prev, lastBackup: result, lastSuccess: result.ok ? result : prev.lastSuccess };
  await writeAtomic(stateFile(p), JSON.stringify(state, null, 2) + "\n", 0o644);
}

// The latest restore test of an app (see verify.js).
export async function recordVerify(name, result, p = paths()) {
  const state = await loadState(p);
  state.projects[name] = { ...(state.projects[name] ?? {}), lastVerify: result };
  await writeAtomic(stateFile(p), JSON.stringify(state, null, 2) + "\n", 0o644);
}

// Which part of the backup data the next restore test reads (see verify.js).
export async function recordDataCheck(next, p = paths()) {
  const state = await loadState(p);
  state.dataCheck = { next, at: new Date().toISOString() };
  await writeAtomic(stateFile(p), JSON.stringify(state, null, 2) + "\n", 0o644);
}

// The last scheduled run's outcome, to say "working again" after a failure.
export async function recordScheduled(ok, p = paths()) {
  const state = await loadState(p);
  state.lastScheduled = { at: new Date().toISOString(), ok };
  await writeAtomic(stateFile(p), JSON.stringify(state, null, 2) + "\n", 0o644);
}

export async function acquireLock(p = paths()) {
  const file = lockFile(p);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(file, "wx", 0o644);
      await fh.writeFile(String(process.pid));
      await fh.close();
      return () => rm(file, { force: true });
    } catch (err) {
      if (err.code === "ENOENT") {
        await mkdir(p.dataDir, { recursive: true, mode: 0o755 }).catch((e) => Promise.reject(fsError(e, p.dataDir)));
        continue;
      }
      if (err.code !== "EEXIST") throw fsError(err, file);
      const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
      if (pid && pid !== process.pid && isAlive(pid)) {
        throw new UserError(`Another backup is already running (process ${pid}).`, "Wait for it to finish, then try again.");
      }
      await rm(file, { force: true }); // left behind by a crashed run
    }
  }
  throw new UserError(`Couldn't take the backup lock (${file}).`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
