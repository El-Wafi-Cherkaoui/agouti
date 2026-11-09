// Reads database settings from an app's .env file, only after the user agreed to it.
// Only the database lines (DB_*, and DATABASE_URL as Prisma and other Node apps write
// it) are parsed and kept; every other line (APP_KEY, mail and payment keys...) is
// dropped as soon as it's read, and never stored, logged or returned.
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
    const m = line.match(/^\s*(?:export\s+)?(DB_[A-Z_]+|DATABASE_URL)\s*=\s*(.*)$/);
    if (m) db[m[1]] = parseValue(m[2]);
  }

  // Laravel 11 accepts a single DB_URL instead of separate settings; Prisma and
  // many Node apps use DATABASE_URL. Node apps often write DB_NAME, DB_USER, DB_PASS.
  const urlKey = db.DB_URL ? "DB_URL" : db.DATABASE_URL ? "DATABASE_URL" : null;
  const fromUrl = urlKey ? parseDbUrl(db[urlKey], urlKey) : {};
  const s = {
    connection: engine(db.DB_CONNECTION ?? fromUrl.connection ?? db.DB_DIALECT ?? db.DB_CLIENT),
    host: db.DB_HOST ?? fromUrl.host ?? "127.0.0.1",
    port: Number(db.DB_PORT ?? fromUrl.port ?? 3306),
    socket: db.DB_SOCKET || undefined,
    database: db.DB_DATABASE ?? db.DB_NAME ?? fromUrl.database,
    username: db.DB_USERNAME ?? db.DB_USER ?? fromUrl.username,
    password: db.DB_PASSWORD ?? db.DB_PASS ?? fromUrl.password ?? "",
  };

  if (!s.connection && !s.database) throw new UserError("The .env file has no database settings (DB_CONNECTION, DB_DATABASE, DATABASE_URL...).");
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
  if (!s.database || !s.username) throw new UserError("The .env file is missing the database name or the username.");
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new UserError(`DB_PORT isn't a valid port.`);
  return s;
}

// mysql2 is the Node driver's name (knex, Sequelize); it's MySQL all the same.
const engine = (v) => (v ? v.toLowerCase().replace(/^mysql2$/, "mysql") : undefined);

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

function parseDbUrl(url, key) {
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
    throw new UserError(`${key} in .env isn't a valid URL.`);
  }
}
