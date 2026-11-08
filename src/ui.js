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
export function setAgoutiCommand(script, { node = process.execPath, dirs = SUDO_PATH } = {}) {
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
export const withCommand = (text) => (command && typeof text === "string" ? text.replace(/\bsudo agouti\b/g, command) : text);

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
export function shellQuote(s) {
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
