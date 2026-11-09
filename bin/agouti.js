#!/usr/bin/env node
import { run } from "../src/cli.js";
import { adaptOutputForWindows, setAgoutiCommand } from "../src/ui.js";

setAgoutiCommand(process.argv[1]);
adaptOutputForWindows();

await run(process.argv.slice(2));
