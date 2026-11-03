import { requireConfig } from "../config.js";
import { runVerify, setupVerifyFlow } from "../flows/verify.js";
import { paths } from "../paths.js";
import { defaultAsk } from "../prompts.js";
import { UserError, info, ok } from "../ui.js";
import { VERIFY_USER, setupVerifier } from "../verify.js";

export const usage = `Usage: agouti verify [<app>...]
       agouti verify --setup [--db-admin-user <user>]

Test that backups can be restored: restores the latest restore point of each
app (all, or the ones named) for real, checks it, and deletes it again.
  · database: into a throwaway database agouti_verify_<app>; tables and rows counted
  · files: a sample restored and compared with the live files
Warns when something looks wrong compared with the last test (a table that lost
most of its rows, most files gone). Exits with status 1 unless all is well.

Scheduled backups run this once a week automatically, once set up.

Options:
  --setup                 Create the MySQL user ${VERIFY_USER} (needed once). It can only
                          create and drop databases named agouti_verify_*.
  --db-admin-user <user>  Admin to create it with (default: root via the local
                          socket). Password in AGOUTI_DB_ADMIN_PASSWORD; not stored.`;

export const options = { setup: { type: "boolean" }, "db-admin-user": { type: "string" } };

export async function verify({ positionals, values }, { ask = defaultAsk, p = paths(), tty = process.stdin.isTTY && process.stdout.isTTY } = {}) {
  if (values.setup) {
    if (positionals.length) throw new UserError("--setup takes no app names.");
    if (!values["db-admin-user"] && tty) return setupVerifyFlow(ask, { p });
    const config = await requireConfig(p);
    const first = Object.values(config.projects ?? {})[0];
    if (!first) throw new UserError("Add an app first: there's nothing to test yet.");
    const db = first.database;
    const server = db.socket ? { socket: db.socket } : { host: db.host, port: db.port ?? 3306 };
    const admin = values["db-admin-user"]
      ? { user: values["db-admin-user"], password: process.env.AGOUTI_DB_ADMIN_PASSWORD ?? "", host: server.host, port: server.port }
      : {};
    await setupVerifier(server, { admin, p });
    return ok(`Restore tests are set up (MySQL user ${VERIFY_USER}). Run them now: sudo agouti verify`);
  }
  const r = await runVerify(positionals, { p });
  if (!r.ok) process.exitCode = 1;
  else info("");
}
