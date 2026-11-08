// File names restic can't hand back as they are. Its JSON listing replaces bytes
// that aren't valid UTF-8 (old Latin-1 names: "caf\xe9.pdf") with U+FFFD, and Node
// can't pass such bytes as arguments anyway. And --include takes a pattern, so a
// name like "rapport[1].pdf" never matched itself.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { sep } from "node:path";

const REPLACED = "�";

// A restic --include pattern that matches exactly this path: pattern characters
// escaped, and each replaced byte matched by "?" (one byte each).
export function includePattern(path) {
  return path.replace(/[\\*?[]/g, (c) => `\\${c}`).replaceAll(REPLACED, "?");
}

// The path as it really is on disk, for a path read from restic's listing. A plain
// string when it exists as written; otherwise each component holding U+FFFD is
// looked up among its folder's raw names, and a Buffer path (usable with any fs
// function) is returned. null if it isn't there.
export async function onDisk(path) {
  if (existsSync(path)) return path;
  if (!path.includes(REPLACED)) return null;
  const parts = path.split(sep);
  let at = Buffer.from(parts[0] || sep);
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    let next = null;
    if (part.includes(REPLACED)) {
      const entries = await readdir(at, { encoding: "buffer" }).catch(() => []);
      const raw = entries.find((e) => e.toString("utf8") === part);
      if (raw) next = Buffer.concat([at, Buffer.from(at.at(-1) === 0x2f ? "" : sep), raw]);
    } else next = Buffer.concat([at, Buffer.from(at.at(-1) === 0x2f ? "" : sep), Buffer.from(part)]);
    if (!next) return null;
    at = next;
  }
  return existsSync(at) ? at : null;
}

