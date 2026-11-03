const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const green = paint(32);
export const yellow = paint(33);
export const red = paint(31);
export const bold = paint(1);
export const dim = paint(2);

export const ok = (msg) => console.log(`${green("✓")} ${msg}`);
export const warn = (msg) => console.log(`${yellow("⚠")} ${msg}`);
export const info = (msg) => console.log(msg);

// An error the user can act on. The CLI prints it without a stack trace.
export class UserError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}
