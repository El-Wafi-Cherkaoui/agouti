#!/usr/bin/env node
import { run } from "../src/cli.js";
import { setAgoutiCommand } from "../src/ui.js";

setAgoutiCommand(process.argv[1]);

await run(process.argv.slice(2));
