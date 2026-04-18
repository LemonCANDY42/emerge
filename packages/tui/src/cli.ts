#!/usr/bin/env node
/**
 * emerge-tui CLI entry point.
 *
 * Subcommands:
 *   emerge-tui live --jsonl <path>    Tail a JSONL file in live mode
 *   emerge-tui replay <path>          Interactive replay scrubber
 *
 * Global flags:
 *   --no-color    Disable color output (pass through to Ink)
 *
 * Exit codes:
 *   0  normal exit
 *   1  file-not-found / parse-error / unhandled exception
 */

import { existsSync } from "node:fs";
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import { LiveApp } from "./components/LiveApp.js";
import { ReplayApp } from "./components/ReplayApp.js";
import { readAllLines, tailFile } from "./parser.js";
import { applyEvent } from "./state/reducer.js";
import { EMPTY_STATE, type TuiState } from "./state/types.js";

const program = new Command();
program
  .name("emerge-tui")
  .description("Ink-based terminal monitor for emerge agent sessions")
  .version("0.0.0");

// ─── live subcommand ──────────────────────────────────────────────────────────

program
  .command("live")
  .description("Tail a JSONL file and display live updates")
  .option("--jsonl <path>", "Path to the JSONL file to tail")
  .option("--no-color", "Disable color output")
  .action(async (opts: { jsonl?: string; color: boolean }) => {
    const jsonlPath = opts.jsonl;
    if (!jsonlPath) {
      process.stderr.write("[emerge-tui] --jsonl <path> is required for live mode\n");
      process.exit(1);
    }

    // Disable color if requested
    if (!opts.color) {
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
      process.env["FORCE_COLOR"] = "0";
    }

    let currentState: TuiState = EMPTY_STATE;
    let rerenderFn: ((state: TuiState) => void) | undefined;

    // We manage state externally so tailFile callbacks can update the render
    const StateWrapper = (): React.ReactElement => {
      const [state, setState] = React.useState<TuiState>(currentState);

      React.useEffect(() => {
        rerenderFn = (s: TuiState) => setState(s);
        return () => {
          rerenderFn = undefined;
        };
      }, []);

      return React.createElement(LiveApp, { state });
    };

    const instance = render(React.createElement(StateWrapper));

    const tailer = tailFile(jsonlPath, (event) => {
      currentState = applyEvent(currentState, event);
      rerenderFn?.(currentState);
    });

    try {
      await instance.waitUntilExit();
    } finally {
      tailer.stop();
    }

    process.exit(0);
  });

// ─── replay subcommand ────────────────────────────────────────────────────────

program
  .command("replay <path>")
  .description("Interactive replay scrubber for a recorded JSONL session")
  .option("--no-color", "Disable color output")
  .action(async (filePath: string, opts: { color: boolean }) => {
    if (!existsSync(filePath)) {
      process.stderr.write(`[emerge-tui] File not found: ${filePath}\n`);
      process.exit(1);
    }

    if (!opts.color) {
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
      process.env["FORCE_COLOR"] = "0";
    }

    let events: Awaited<ReturnType<typeof readAllLines>>;
    try {
      events = await readAllLines(filePath);
    } catch (err) {
      process.stderr.write(`[emerge-tui] Failed to read file: ${String(err)}\n`);
      process.exit(1);
    }

    const instance = render(React.createElement(ReplayApp, { events }));

    try {
      await instance.waitUntilExit();
    } catch (err) {
      process.stderr.write(`[emerge-tui] Unhandled error: ${String(err)}\n`);
      process.exit(1);
    }

    process.exit(0);
  });

// ─── Error handling ───────────────────────────────────────────────────────────

program.exitOverride((err) => {
  process.stderr.write(`[emerge-tui] ${err.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[emerge-tui] Unhandled rejection: ${String(reason)}\n`);
  process.exit(1);
});

program.parse(process.argv);
