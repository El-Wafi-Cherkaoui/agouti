// Reads database settings from an app's .env file, only after the user agreed to it.
// Only DB_* lines are parsed and kept; every other line (APP_KEY, mail and payment
// keys...) is dropped as soon as it's read, and never stored, logged or returned.
import { readFile } from "node:fs/promises";
import { UserError } from "./ui.js";

const SUPPORTED = ["mysql", "mariadb"];

export async function readDatabaseSettings(envPath) {
  let text;
  try {
    text = await readFile(envPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw new UserError(`There's no .env file at ${envPath}.`);
    throw err;
  }
  return databaseSettingsFrom(text);
}

export function databaseSettingsFrom(text) {
  const db = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?(DB_[A-Z_]+)\s*=\s*(.*)$/);
    if (m) db[m[1]] = parseValue(m[2]);
  }

  // Laravel 11 accepts a single DB_URL instead of separate settings.
  const fromUrl = db.DB_URL ? parseDbUrl(db.DB_URL) : {};
  const s = {
    connection: db.DB_CONNECTION ?? fromUrl.connection,
    host: db.DB_HOST ?? fromUrl.host ?? "127.0.0.1",
    port: Number(db.DB_PORT ?? fromUrl.port ?? 3306),
    socket: db.DB_SOCKET || undefined,
    database: db.DB_DATABASE ?? fromUrl.database,
    username: db.DB_USERNAME ?? fromUrl.username,
    password: db.DB_PASSWORD ?? fromUrl.password ?? "",
  };

  if (!s.connection && !s.database) throw new UserError("The .env file has no database settings (DB_CONNECTION, DB_DATABASE...).");
  if (s.connection && !SUPPORTED.includes(s.connection)) {
    throw new UserError(`This app uses ${s.connection}. Agouti supports MySQL and MariaDB for now (Postgres is planned).`);
  }
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === "string" && v.includes("${")) {
      throw new UserError(
        `DB setting "${k}" refers to another variable (\${...}), which Agouti doesn't resolve.`,
        "Enter the database details manually instead.",
      );
    }
  }
  if (!s.database || !s.username) throw new UserError("The .env file is missing DB_DATABASE or DB_USERNAME.");
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new UserError(`DB_PORT isn't a valid port.`);
  return s;
}

// dotenv rules: "double quotes" allow escapes, 'single quotes' are literal,
// unquoted values end at a " #" comment.
function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const end = findClosingQuote(v);
    return v.slice(1, end).replace(/\\(["\\n])/g, (_, c) => (c === "n" ? "\n" : c));
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    return v.slice(1, end === -1 ? undefined : end);
  }
  return v.replace(/\s+#.*$/, "");
}

function findClosingQuote(v) {
  for (let i = 1; i < v.length; i++) {
    if (v[i] === "\\") i++;
    else if (v[i] === '"') return i;
  }
  return v.length;
}

function parseDbUrl(url) {
  try {
    const u = new URL(url);
    return {
      connection: u.protocol.replace(/:$/, ""),
      host: u.hostname || undefined,
      port: u.port || undefined,
      database: decodeURIComponent(u.pathname.replace(/^\//, "")) || undefined,
      username: decodeURIComponent(u.username) || undefined,
      password: decodeURIComponent(u.password) || undefined,
    };
  } catch {
    throw new UserError("DB_URL in .env isn't a valid URL.");
  }
}
