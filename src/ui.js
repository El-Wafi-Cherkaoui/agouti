import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const green = paint(32);
export const yellow = paint(33);
export const red = paint(31);
export const bold = paint(1);
export const dim = paint(2);

// How to run Agouti as root on this server, for the commands we suggest. sudo only
// searches a few system folders, so when Node or Agouti live elsewhere (nvm, a git
// checkout) "sudo agouti" fails: suggest the full command instead. Set once by the
// CLI; elsewhere (tests, imports) suggestions stay as written.
let command = null;
export function setAgoutiCommand(script, { node = process.execPath, dirs = SUDO_PATH, platform = process.platform } = {}) {
  // Windows has no sudo: the terminal itself runs as administrator. npm installs an
  // agouti.cmd next to node; from a git checkout, name node and the script.
  if (platform === "win32") {
    const installed = (process.env.PATH ?? "").split(";").some((d) => d && existsSync(join(d, "agouti.cmd")));
    command = installed ? "agouti" : `${shellQuote(node, platform)} ${shellQuote(realpathSync(script), platform)}`;
    return command;
  }
  const onSudoPath = dirs.some((d) => {
    try {
      return realpathSync(join(d, "agouti")) === realpathSync(script);
    } catch {
      return false;
    }
  });
  const nodeOnSudoPath = dirs.some((d) => existsSync(join(d, "node")) && realpathSync(join(d, "node")) === realpathSync(node));
  command = onSudoPath && nodeOnSudoPath ? null : `sudo ${shellQuote(node)} ${shellQuote(realpathSync(script))}`;
  return command ?? "sudo agouti";
}
const SUDO_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin", "/snap/bin"];
// No \b before "sudo": in bold text it follows the escape code's "m", a letter.
export const withCommand = (text) => (command && typeof text === "string" ? text.replace(/(?:(?<![\w-])|(?<=\x1b\[[0-9;]*m))sudo agouti\b/g, command) : text);

// Windows consoles and cmd's `type` can't show every symbol. In a terminal, cmd's
// default font lacks ⏎ (the menus' "⏎ select"); in a log file (the scheduled task's
// output, read with `type`) UTF-8 symbols come out as "Γ£ô", so they're written in
// plain ASCII there. Letters (é, ü) are left alone: they're data, like file names.
const LOG_SYMBOLS = { "✓": "ok", "✔": "ok", "√": "ok", "✕": "x", "×": "x", "⚠": "!", "·": "-", "→": "->", "…": "...", "•": "*", "─": "-", "⏎": "enter", "↑": "up", "↓": "down" };
const TERMINAL_SYMBOLS = { "⏎": "enter" };
export function windowsText(text, { tty }) {
  const map = tty ? TERMINAL_SYMBOLS : LOG_SYMBOLS;
  return text.replace(/[✓✔√✕×⚠·→…•─⏎↑↓]/g, (c) => map[c] ?? c);
}

// Applies windowsText to everything written to stdout and stderr (the menus included).
export function adaptOutputForWindows(platform = process.platform) {
  if (platform !== "win32") return;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    const tty = Boolean(stream.isTTY);
    stream.write = (chunk, ...rest) => {
      // Strings only: a Buffer may end halfway through a character.
      return write(typeof chunk === "string" ? windowsText(chunk, { tty }) : chunk, ...rest);
    };
  }
}

export const ok = (msg) => console.log(`${green("✓")} ${withCommand(msg)}`);
export const warn = (msg) => console.log(`${yellow("⚠")} ${withCommand(msg)}`);
export const info = (msg) => console.log(withCommand(msg));

// An error the user can act on. The CLI prints it without a stack trace.
export class UserError extends Error {
  constructor(message, hint) {
    super(withCommand(message));
    this.hint = withCommand(hint);
  }
}

// Quotes a path or argument so a shell reads it back exactly, for commands we print
// for people to paste (often as root). Upload names are chosen by users: a quote
// must not end the string, and control characters (newlines, terminal escapes)
// are written as \n, \x1b... inside $'...' so they're visible and inert.
// A Buffer path (a name that isn't valid UTF-8) is written byte for byte as \xNN.
export function shellQuote(s, platform = process.platform) {
  // cmd.exe (what an SSH session to Windows opens): double quotes. Windows names
  // can't contain " or control characters.
  if (platform === "win32") {
    const text = Buffer.isBuffer(s) ? s.toString("utf8") : String(s);
    return /^[A-Za-z0-9_\\/.,:@+=-]+$/.test(text) ? text : `"${text}"`;
  }
  if (Buffer.isBuffer(s)) {
    if (Buffer.from(s.toString("utf8")).equals(s)) return shellQuote(s.toString("utf8"));
    const esc = [...s].map((b) => (b === 0x27 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 0x20 || b >= 0x7f ? `\\x${b.toString(16).padStart(2, "0")}` : String.fromCharCode(b))).join("");
    return `$'${esc}'`;
  }
  if (/^[A-Za-z0-9_\/.,:@%+=-]+$/.test(s)) return s;
  if (/[\x00-\x1f\x7f]/.test(s)) {
    const esc = s.replace(/[\\']/g, (c) => `\\${c}`).replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
    return `$'${esc}'`;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// " (14:01 local)" for a UTC time, when this server's clock isn't on UTC: restore
// points are named in UTC, but people think in their own time. "" on a UTC server.
// The system's own time zone rules decide (`date`), not Node's: Node carries a
// built-in copy that can be older than the system's (it still had Morocco on UTC+1
// after Morocco moved to UTC+0 in September 2026). timeZone: tests only.
export function localNote(iso, { timeZone } = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const utc = d.toISOString().slice(0, 16).replace("T", " ");
  const local = timeZone ? intlLocal(d, timeZone) : systemLocal(d);
  if (!local || local === utc) return "";
  return ` (${local.slice(0, 10) === utc.slice(0, 10) ? local.slice(11) : local} local)`;
}

const localCache = new Map();
function systemLocal(d) {
  const key = `${process.env.TZ ?? ""}@${Math.floor(d.getTime() / 60000)}`;
  if (!localCache.has(key)) {
    // Windows has no `date` of its own: one found on the PATH (Git's) may not know
    // zone names. Node follows Windows' time zone setting there.
    if (process.platform === "win32") {
      localCache.set(key, intlLocal(d));
      return localCache.get(key);
    }
    const r = spawnSync("date", ["-d", `@${Math.floor(d.getTime() / 1000)}`, "+%Y-%m-%d %H:%M"], { encoding: "utf8", timeout: 2000 });
    localCache.set(key, r.status === 0 ? r.stdout.trim() : intlLocal(d)); // no `date` (or not GNU): Node's rules
  }
  return localCache.get(key);
}

function intlLocal(d, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
