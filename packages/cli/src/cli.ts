#!/usr/bin/env node
/**
 * @emerge/cli — entry point for the `emerge` command.
 *
 * Subcommands:
 *   emerge run <blueprint.yaml>       — run a configured agent
 *   emerge replay <session.jsonl>     — replay a recorded session
 *   emerge probe <provider-config>    — probe a provider's capability ceiling
 *   emerge status                     — show recent session summaries
 */

import { Command } from "commander";
import { probeCommand } from "./commands/probe.js";
import { replayCommand } from "./commands/replay.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";

const program = new Command();

program.name("emerge").description("emerge agent harness CLI").version("0.0.0");

program
  .command("run <blueprint>")
  .description("Load a YAML blueprint and run the configured agent")
  .option("--output-dir <dir>", "Directory for session JSONL output", ".emerge")
  .action(async (blueprint: string, options: { outputDir?: string }) => {
    const opts = options.outputDir !== undefined ? { outputDir: options.outputDir } : {};
    await runCommand(blueprint, opts);
  });

program
  .command("replay <session>")
  .description("Replay a recorded session JSONL file without prompting the model")
  .action(async (session: string) => {
    await replayCommand(session);
  });

program
  .command("probe <provider-config>")
  .description('Run the calibrated probe set against a provider (use "mock" or JSON config)')
  .action(async (providerConfig: string) => {
    await probeCommand(providerConfig);
  });

program
  .command("status")
  .description("Show recent session summaries from the session directory")
  .option("--dir <dir>", "Session directory to read from", ".emerge")
  .option("--last <n>", "Number of recent sessions to show", "5")
  .action(async (options: { dir?: string; last?: string }) => {
    const statusOpts: import("./commands/status.js").StatusOptions = {};
    if (options.dir !== undefined) statusOpts.dir = options.dir;
    if (options.last !== undefined) {
      const parsed = Number.parseInt(options.last, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`[emerge status] --last must be a positive integer, got: "${options.last}"`);
        process.exit(1);
      }
      statusOpts.last = parsed;
    }
    await statusCommand(statusOpts);
  });

program.parse(process.argv);
