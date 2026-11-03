import { isAbsolute, join } from "node:path";
import { requireConfig } from "../config.js";
import { printPoints, restoreFlow, runRestore } from "../flows/restore.js";
import { paths } from "../paths.js";
import { defaultAsk } from "../prompts.js";
import { listPoints, restoreFilesByPath } from "../restore.js";
import { ensureRestic, resticEnv } from "../restic.js";
import { UserError, bold, green, info } from "../ui.js";

export const usage = `Usage: agouti restore [<app>]                      Choose what to restore (interactive)
       agouti restore <app> --list               List restore points
       agouti restore <app> [options]            Restore without questions

By default a restore is a copy: the database goes into a new database next to
the live one (e.g. shop_prod_restored_20261103_0300), files into
/var/lib/agouti/restores/<app>-<point>. Nothing live is touched.

With --replace, the live database and folders are replaced. A restore point of
the current state is made first, so it can be undone.

Options:
  --point <id>            Restore point to use (default: latest)
  --only database|files   Restore only one part
  --file <path>           Restore one file or folder (relative to the app) into the copy folder
  --replace               Replace the live data (asks to confirm; --yes to skip)
  --yes                   Don't ask (for scripts)
  --db-admin-user <user>  MySQL user that can create databases (default: root via
                          the local socket). Password in AGOUTI_DB_ADMIN_PASSWORD.

Examples:
  sudo agouti restore shop --list
  sudo agouti restore shop --only database
  sudo agouti restore shop --point 20261103T030000Z --replace`;

export const options = {
  list: { type: "boolean" },
  point: { type: "string" },
  only: { type: "string" },
  file: { type: "string" },
  replace: { type: "boolean" },
  yes: { type: "boolean" },
  "db-admin-user": { type: "string" },
};

export async function restore({ positionals, values }, { ask = defaultAsk, p = paths(), tty = process.stdin.isTTY && process.stdout.isTTY } = {}) {
  const [app, ...extra] = positionals;
  if (extra.length) throw new UserError("Restore one app at a time.", usage);
  const scripted = values.list || values.point || values.only || values.file || values.replace || values["db-admin-user"];

  if (!scripted) {
    if (!tty) throw new UserError("Say what to restore, e.g. `agouti restore shop --only database`.", "Or run `sudo agouti restore` in a terminal to choose.");
    return restoreFlow(ask, { p, app });
  }
  if (!app) throw new UserError("Which app? e.g. `agouti restore shop --list`.");
  const config = await requireConfig(p);
  if (!config.projects?.[app]) throw new UserError(`Unknown app: ${app}`, `Apps: ${Object.keys(config.projects ?? {}).join(", ") || "none yet"}`);

  if (values.list) {
    const bin = await ensureRestic({ p, log: info });
    return printPoints(app, await listPoints(app, { bin, env: await resticEnv(config, p) }));
  }

  if (values.file) {
    if (values.replace || values.only) throw new UserError("--file restores into the copy folder; it can't be combined with --replace or --only.");
    const path = isAbsolute(values.file) ? values.file : join(config.projects[app].path, values.file);
    const [restored] = await restoreFilesByPath(app, values.point, [path], { p, log: info });
    return info(`${green("✓")} Restored to ${bold(restored)}`);
  }

  if (values.only && !["database", "files"].includes(values.only)) throw new UserError("--only must be database or files.");
  const parts = values.only ? [values.only] : ["database", "files"];
  const mode = values.replace ? "replace" : "copy";
  if (mode === "replace" && !values.yes) {
    if (!tty) throw new UserError("--replace overwrites live data. Add --yes to confirm.");
    const typed = await ask.input({ message: `This replaces the live ${parts.join(" and ")} of ${app}. Type ${app} to confirm` });
    if (typed.trim() !== app) return info("Nothing was changed.");
  }
  const admin = values["db-admin-user"] ? { user: values["db-admin-user"], password: process.env.AGOUTI_DB_ADMIN_PASSWORD ?? "" } : {};
  const result = await runRestore({ app, point: values.point, parts, mode, admin }, { p });
  if (!result.ok) process.exitCode = 1;
}
