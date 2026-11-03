import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { app } from "./app.js";
import * as add from "./commands/add.js";
import * as backup from "./commands/backup.js";
import * as connect from "./commands/connect.js";
import * as init from "./commands/init.js";
import { UserError, dim, red } from "./ui.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const COMMANDS = {
  init: { run: init.init, usage: init.usage, options: init.options, summary: "Create the encrypted backup repository (once per server)", root: true },
  add: { run: add.add, usage: add.usage, options: add.options, summary: "Add an app to back up (database + uploaded files)", root: true },
  backup: { run: backup.backup, usage: backup.usage, options: backup.options, summary: "Back up apps now (all, or the ones named)", root: true },
  connect: { run: connect.connect, usage: connect.usage, options: connect.options, summary: "Use an existing repository, e.g. on a new server", root: true },
};

const HELP = `agouti ${version}: backups for the apps on your server

Usage: sudo agouti              Open the interactive app (start here)
       agouti <command> [options]  Run one action, for scripts and quick use over SSH

Commands:
${Object.entries(COMMANDS)
  .map(([name, c]) => `  ${name.padEnd(10)} ${c.summary}`)
  .join("\n")}

Options:
  -h, --help     Show help for a command
  -v, --version  Show the version

Agouti is in development: schedule and restore are coming next.
https://github.com/El-Wafi-Cherkaoui/agouti`;

export async function main(argv) {
  const [name, ...rest] = argv;

  if (!name) {
    // No command: open the app. Without a terminal (pipes, cron) there's nobody to ask.
    if (!process.stdin.isTTY || !process.stdout.isTTY) return console.log(HELP);
    requireRoot("agouti");
    return app();
  }
  if (name === "-h" || name === "--help" || name === "help") return console.log(HELP);
  if (name === "-v" || name === "--version") return console.log(version);

  const command = COMMANDS[name];
  if (!command) throw new UserError(`Unknown command: ${name}`, "Run `agouti --help` to see the commands.");

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...command.options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UserError(err.message, command.usage);
  }
  if (parsed.values.help) return console.log(command.usage);
  if (command.root) requireRoot(`agouti ${name}`);
  await command.run(parsed);
}

// Fail before doing any work (like downloading restic) rather than halfway through.
// Skipped when the directories are overridden, which is how tests run.
function requireRoot(what) {
  const customDirs = process.env.AGOUTI_CONFIG_DIR && process.env.AGOUTI_DATA_DIR;
  if (!customDirs && process.getuid?.() !== 0) {
    throw new UserError(`\`${what}\` needs root: it manages /etc/agouti and /var/lib/agouti.`, `Run: sudo ${what}`);
  }
}

export async function run(argv) {
  try {
    await main(argv);
  } catch (err) {
    if (err?.name === "ExitPromptError") {
      // Ctrl-C during a question.
      console.log("");
      process.exitCode = 130;
      return;
    }
    if (err instanceof UserError) {
      console.error(`${red("✕")} ${err.message}`);
      if (err.hint) console.error(dim(err.hint));
      process.exitCode = 1;
      return;
    }
    console.error(`${red("✕")} Unexpected error. Please report it at https://github.com/El-Wafi-Cherkaoui/agouti/issues`);
    console.error(err?.stack ?? err);
    process.exitCode = 1;
  }
}
