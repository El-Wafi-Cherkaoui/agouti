// Loading a backed-up dump into a database: restic dump | (filter) | mysql.
// The filter works line by line, and statement by statement inside the
// DELIMITER ;; blocks where mysqldump puts triggers and routines. It counts what
// the dump contains, and for restore tests can adapt it to a restricted user.
import { spawn } from "./children.js";
import { cleanError, mysqlClient } from "./mysql.js";
import { UserError } from "./ui.js";

// opts.restricted: loading as a user without SUPER (restore tests). Definers are
// removed (only SUPER may name another user as definer), and with skipBinlogged,
// triggers and stored functions are left out: with binary logging on, MySQL
// refuses them to anyone without SUPER. They're still counted.
// skipEvents: for a throwaway database. Its events must never run: one that names
// the live database would change it. They're still counted.
export function dumpFilter({ restricted = false, skipBinlogged = false, skipEvents = false } = {}) {
  const stats = { tables: 0, views: 0, triggers: 0, functions: 0, procedures: 0, events: 0, skipped: { triggers: 0, functions: 0 } };
  let inBlock = false;
  let statement = [];

  const fix = (line) => (restricted && !line.startsWith("INSERT INTO") ? line.replace(/DEFINER=`(?:[^`]|``)*`@`(?:[^`]|``)*`/g, "") : line);

  const kind = (text) => {
    if (/^\/\*!50003 CREATE\*\/.*?\/\*!50003 TRIGGER /s.test(text)) return "triggers";
    if (/^\/\*!\d+ CREATE\*\/.*?\/\*!\d+ EVENT /s.test(text)) return "events"; // how mysqldump writes them
    const m = text.match(/^CREATE\s+(?:DEFINER=\S+\s+)?(FUNCTION|PROCEDURE|EVENT)\s/i);
    return m ? { FUNCTION: "functions", PROCEDURE: "procedures", EVENT: "events" }[m[1].toUpperCase()] : null;
  };

  // Returns the text to send on (possibly ""), for one complete line.
  function line(l) {
    if (!inBlock) {
      if (/^CREATE TABLE `/.test(l)) stats.tables++;
      if (/^\/\*!50001 VIEW `/.test(l)) stats.views++;
      if (l === "DELIMITER ;;") inBlock = true;
      return fix(l) + "\n";
    }
    if (l === "DELIMITER ;") {
      inBlock = false;
      return l + "\n";
    }
    statement.push(l);
    if (!l.trimEnd().endsWith(";;")) return "";
    const text = statement.join("\n");
    statement = [];
    const k = kind(text);
    if (k) stats[k]++;
    if (skipBinlogged && (k === "triggers" || k === "functions")) {
      stats.skipped[k]++;
      return "";
    }
    if (skipEvents && k === "events") {
      stats.skipped.events = (stats.skipped.events ?? 0) + 1;
      return "";
    }
    return fix(text) + "\n";
  }
  return { line, stats };
}

// Streams one database part of a restore point into `database`.
// prelude: SQL sent first (e.g. SET SESSION sql_log_bin = 0). Resolves to the filter's stats + bytes.
export function loadDump(part, database, { bin, env, optionFile, onEvent = () => {}, prelude = "", filter = dumpFilter() }) {
  return new Promise((resolve, reject) => {
    const dump = spawn(bin, ["dump", part.snapshot, part.path], { env, stdio: ["ignore", "pipe", "pipe"] });
    const mysql = spawn(mysqlClient(), [`--defaults-extra-file=${optionFile}`, "--default-character-set=utf8mb4", database], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let dumpErr = "";
    let mysqlErr = "";
    let bytes = 0;
    let tail = "";
    dump.stderr.on("data", (d) => (dumpErr += d));
    mysql.stderr.on("data", (d) => (mysqlErr += d));
    mysql.stdin.on("error", () => {}); // mysql quit early: its stderr says why
    if (prelude) mysql.stdin.write(prelude + "\n");

    // latin1 maps bytes 1:1, so multi-byte UTF-8 split across chunks survives intact.
    dump.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      const text = tail + chunk.toString("latin1");
      const cut = text.lastIndexOf("\n");
      tail = cut === -1 ? text : text.slice(cut + 1);
      if (cut !== -1) {
        let out = "";
        for (const l of text.slice(0, cut).split("\n")) out += filter.line(l);
        if (out && !mysql.stdin.write(Buffer.from(out, "latin1"))) {
          dump.stdout.pause();
          mysql.stdin.once("drain", () => dump.stdout.resume());
        }
      }
      onEvent({ type: "progress", part: "database", bytesDone: bytes, totalBytes: part.bytes ?? 0, percent: part.bytes ? bytes / part.bytes : undefined });
    });
    dump.stdout.on("end", () => {
      if (tail) mysql.stdin.write(Buffer.from(filter.line(tail), "latin1"));
      mysql.stdin.end();
    });

    let pending = 2;
    let dumpCode;
    let mysqlCode;
    let stoppedDump = false;
    const done = () => {
      if (--pending) return;
      // A read that fails cuts the dump off mid-statement, and mysql then complains about
      // the SQL. So look at restic first, unless it only stopped because mysql had quit.
      const dumpGaveUp = dumpCode !== 0 && !(stoppedDump && (dumpCode === null || dumpCode === 130));
      if (dumpGaveUp) return reject(unreadable(dumpErr, dumpCode));
      if (mysqlCode !== 0) return reject(new UserError(`Loading the dump failed: ${cleanError(mysqlErr) || `exit code ${mysqlCode}`}`));
      resolve({ ...filter.stats, bytes });
    };
    dump.on("error", reject);
    mysql.on("error", (e) => reject(e.code === "ENOENT" ? new UserError("The mysql client isn't installed.") : e));
    dump.on("close", (code) => ((dumpCode = code), done()));
    mysql.on("close", (code) => {
      mysqlCode = code;
      if (code !== 0) {
        stoppedDump = true;
        dump.kill(); // nothing more will be read
      }
      done();
    });
  });
}

function unreadable(stderr, code) {
  return new UserError(`Reading the backup failed: ${lastError(stderr) || `exit code ${code}`}`, "The backup storage may be damaged. Try another restore point, and check the drive or storage.");
}

// Reads one database part all the way through without keeping it: restic checks
// each piece as it reads, so a damaged backup fails here.
export function readDump(part, { bin, env }) {
  return new Promise((resolve, reject) => {
    const dump = spawn(bin, ["dump", part.snapshot, part.path], { env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    dump.stderr.on("data", (d) => (err += d));
    dump.on("error", reject);
    dump.on("close", (code) => (code === 0 ? resolve() : reject(unreadable(err, code))));
  });
}

function lastError(stderr) {
  const l = stderr.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(l).message ?? l;
  } catch {
    return l.replace(/^Fatal: /, "");
  }
}
