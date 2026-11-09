// Files an app leaves out of its backups (`exclude:` in agouti.yml). An entry is:
//   a name:  "thumbs", "*.tmp"      anywhere inside the backed-up folders
//   a path:  "storage/app/public/thumbs", relative to the app, inside a backed-up folder
//
// restic matches a pattern against the whole absolute path, so every pattern here is
// anchored to a backed-up folder, whose own path is escaped. Otherwise a bare "thumbs"
// would also match /srv/thumbs/shop, the folder above the app, and restic would save
// an empty snapshot without complaint.
//
// An entry that can't be applied safely is ignored and reported: a typo in the config
// must never make a backup hold less than it should.
import { isAbsolute, posix, resolve } from "node:path";
import { escapePattern, isWindows } from "./platform.js";
import { UserError } from "./ui.js";

const escapeGlob = (s) => escapePattern(s);
const trimSlashes = (s) => s.replace(/\/+$/, "");
const everything = (s) => s.split("/").every((part) => /^\*+$/.test(part));
const ALL = "it would leave out every file";

// Which backed-up folders an entry applies to, as { folder, rest }, or why it can't be used.
function parseEntry(entry, folders) {
  if (typeof entry !== "string" || !entry.trim()) return { reason: "it isn't a file or folder name" };
  // Windows: people write storage\app\thumbs; agouti.yml keeps / on every system.
  const text = isWindows() ? entry.trim().replace(/\\/g, "/") : entry.trim();
  if (text.startsWith("/") || (isWindows() && /^[A-Za-z]:/.test(text))) return { reason: "it must be relative to the app" };
  const clean = trimSlashes(posix.normalize(text));
  if (clean === ".." || clean.startsWith("../")) return { reason: "it must stay inside the app" };

  if (!clean.includes("/")) {
    if (everything(clean)) return { reason: ALL };
    if (folders.includes(clean)) return { reason: "it's a whole backed-up folder (remove it from files instead)" };
    return { clean, matches: folders.map((folder) => ({ folder, rest: `**/${clean}` })) };
  }
  if (folders.some((f) => f === clean || f.startsWith(`${clean}/`))) {
    return { reason: "it's a whole backed-up folder (remove it from files instead)" };
  }
  const matches = folders.filter((f) => clean.startsWith(`${f}/`)).map((folder) => ({ folder, rest: clean.slice(folder.length + 1) }));
  if (!matches.length) return { reason: "it isn't inside a folder that's backed up" };
  if (matches.some((m) => everything(m.rest))) return { reason: ALL };
  return { clean, matches };
}

// A folder outside the app (a full path) is kept as it is: only name entries apply to it.
const relativeFolders = (project) => (project.files ?? []).map((f) => (isAbsolute(f) ? f : trimSlashes(posix.normalize(f))));

// The --exclude patterns for backing up a project, and the entries that were ignored.
export function excludePatterns(project) {
  const patterns = [];
  const ignored = [];
  for (const entry of project.exclude ?? []) {
    const parsed = parseEntry(entry, relativeFolders(project));
    if (parsed.reason) {
      ignored.push(`"${entry}": ${parsed.reason}`);
      continue;
    }
    for (const { folder, rest } of parsed.matches) patterns.push(`${escapeGlob(resolve(project.path, folder))}/${rest}`);
  }
  return { patterns: [...new Set(patterns)], ignored };
}

// For `agouti add --exclude`, where a mistake can simply be refused.
export function validateExcludes(entries, files) {
  const folders = relativeFolders({ files });
  const out = [];
  for (const entry of entries.map((x) => x.trim()).filter(Boolean)) {
    const parsed = parseEntry(entry, folders);
    if (parsed.reason) throw new UserError(`Can't exclude "${entry}": ${parsed.reason}.`);
    if (!out.includes(parsed.clean)) out.push(parsed.clean);
  }
  return out;
}

// A restore of `folder` with `snap:folder` sees paths starting at that folder, so a
// snapshot's patterns (see excludePatterns) are rewritten to start there too.
// restic restore --delete removes whatever isn't in the snapshot unless it's excluded,
// which would include the live files this snapshot deliberately left out.
export function restoreExcludes(patterns, folder) {
  const prefix = `${escapeGlob(trimSlashes(folder))}/`;
  return (patterns ?? []).filter((x) => x.startsWith(prefix)).map((x) => `/${x.slice(prefix.length)}`);
}
