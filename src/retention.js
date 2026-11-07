// Deleting restore points that are no longer needed, so storage doesn't grow forever.
//
// Decisions are made per restore point (database + files together), not per restic
// snapshot: restic's own `forget --keep-daily` would judge each part separately and
// could keep Monday's database with Tuesday's files. Here a point is kept or
// deleted as a whole.
import { EXIT, clearStaleLocks, lockedMessage, run } from "./restic.js";

export const DEFAULT_RETENTION = { daily: 7, weekly: 4, monthly: 12 };
// Points made just before a restore replaced live data: kept this long, and kept
// out of the daily/weekly/monthly count, so they never push out a regular backup.
export const SAFETY_DAYS = 7;

// Which points to keep, like restic's --keep-daily/weekly/monthly: the newest
// point of each of the last N days (weeks, months) that have one. Only complete
// points count; an incomplete point is kept only while it's the newest thing
// there is (its files may be the latest copy). The newest point is always kept.
// points: [{ id, at: Date, complete }]. Returns a Set of ids.
export function pointsToKeep(points, policy = DEFAULT_RETENTION) {
  const sorted = [...points].sort((a, b) => b.at - a.at);
  const keep = new Set();
  if (!sorted.length) return keep;
  keep.add(sorted[0].id);

  const complete = sorted.filter((pt) => pt.complete);
  const newestComplete = complete[0]?.at ?? -Infinity;
  for (const pt of sorted) if (pt.at > newestComplete) keep.add(pt.id);

  const buckets = { daily: dayKey, weekly: weekKey, monthly: monthKey };
  for (const [rule, key] of Object.entries(buckets)) {
    const n = Number(policy[rule] ?? 0);
    let last;
    let count = 0;
    for (const pt of complete) {
      if (count >= n) break;
      const k = key(pt.at);
      if (k === last) continue;
      last = k;
      count++;
      keep.add(pt.id);
    }
  }
  return keep;
}

const dayKey = (d) => d.toISOString().slice(0, 10);
const monthKey = (d) => d.toISOString().slice(0, 7);
// ISO 8601 week: weeks start on Monday; week 1 holds the year's first Thursday.
export function weekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7)); // Thursday of this week decides the year
  const n = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${n}`;
}

// Applies the policy to every app in the config. Apps no longer in the config are
// left alone: deleting someone's last copy of a removed app is not our call.
// Returns { apps: { name: { kept, deleted } }, pruned }.
export async function applyRetention(config, { bin, env, policy = config.retention ?? DEFAULT_RETENTION, log = () => {}, now = Date.now() }) {
  const r = await run(bin, ["snapshots", "--json", "--tag", "agouti"], { env });
  if (r.code !== 0) throw new Error(`Couldn't list restore points: ${r.stderr.trim().split("\n").at(-1)}`);
  const snapshots = JSON.parse(r.stdout || "[]") ?? [];

  const byApp = new Map();
  for (const s of snapshots) {
    const tag = (name) => s.tags?.find((t) => t.startsWith(`${name}=`))?.slice(name.length + 1);
    const app = tag("app");
    const point = tag("point");
    if (!app || !point || !config.projects?.[app]) continue;
    const points = byApp.get(app) ?? new Map();
    const pt = points.get(point) ?? { id: point, at: new Date(s.time), parts: new Set(), snapshots: [] };
    pt.parts.add(tag("part"));
    if (s.tags.includes("kind=safety")) pt.safety = true;
    pt.snapshots.push(s.id);
    if (new Date(s.time) < pt.at) pt.at = new Date(s.time);
    points.set(point, pt);
    byApp.set(app, points);
  }

  const result = { apps: {}, pruned: false };
  const forget = [];
  for (const [app, points] of byApp) {
    const project = config.projects[app];
    const complete = (pt) => pt.parts.has("database") && (!project.files?.length || pt.parts.has("files"));
    const all = [...points.values()].map((pt) => ({ ...pt, complete: complete(pt) }));
    const list = all.filter((pt) => !pt.safety);
    const keep = pointsToKeep(list, policy);
    for (const pt of all) if (pt.safety && now - pt.at < SAFETY_DAYS * 86400000) keep.add(pt.id);
    const drop = all.filter((pt) => !keep.has(pt.id));
    for (const pt of drop) forget.push(...pt.snapshots);
    result.apps[app] = { kept: keep.size, deleted: drop.length };
  }

  if (forget.length) {
    log(`Deleting ${forget.length} old ${forget.length === 1 ? "snapshot" : "snapshots"}...`);
    await clearStaleLocks(bin, env); // forget and prune refuse while an interrupted run's lock is there
    // In batches, to stay well under the command-line length limit.
    for (let i = 0; i < forget.length; i += 200) {
      const f = await run(bin, ["forget", ...forget.slice(i, i + 200)], { env });
      if (f.code === EXIT.LOCKED) throw new Error(lockedMessage("Couldn't delete old restore points"));
      if (f.code !== 0) throw new Error(`Couldn't delete old restore points: ${f.stderr.trim().split("\n").at(-1)}`);
    }
    // forget only drops the references; prune frees the space.
    const pr = await run(bin, ["prune"], { env });
    if (pr.code === EXIT.LOCKED) throw new Error(lockedMessage("Couldn't free the space of deleted restore points"));
    if (pr.code !== 0) throw new Error(`Couldn't free the space of deleted restore points: ${pr.stderr.trim().split("\n").at(-1)}`);
    result.pruned = true;
  }
  return result;
}
