#!/usr/bin/env node
/**
 * emerge-dashboard CLI entry point.
 *
 * Usage:
 *   emerge-dashboard --jsonl <path>           Live tail mode
 *   emerge-dashboard --session <path>         Replay mode (static snapshot)
 *   emerge-dashboard --port <n>               HTTP+WS port (default 7777)
 *   emerge-dashboard --listen <host>          Bind host (default 127.0.0.1)
 *
 * Security: the default bind is 127.0.0.1 (loopback only).
 * Passing --listen 0.0.0.0 opts in to network exposure and prints a
 * warning to stderr. This is intentional: exposing an unauthenticated
 * WebSocket endpoint to the network should be an explicit decision.
 *
 * Exit codes:
 *   0  server started (runs until SIGINT/SIGTERM)
 *   1  bad arguments or startup failure
 */

import { existsSync } from "node:fs";
import { Command } from "commander";
import { startServer } from "./index.js";

const DEFAULT_PORT = 7777;
const DEFAULT_HOST = "127.0.0.1";

const program = new Command();

program
  .name("emerge-dashboard")
  .description("Vite+React+WebSocket browser monitor for emerge agent sessions")
  .version("0.0.0")
  .option("--jsonl <path>", "Path to a JSONL file to tail (live mode)")
  .option("--session <path>", "Path to a JSONL file to replay (static mode)")
  .option("--port <n>", "HTTP+WebSocket port", String(DEFAULT_PORT))
  .option("--listen <host>", "Bind host", DEFAULT_HOST)
  .action(async (opts: { jsonl?: string; session?: string; port: string; listen: string }) => {
    const host = opts.listen;
    const port = Number.parseInt(opts.port, 10);

    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      process.stderr.write(`[emerge-dashboard] Invalid port: ${opts.port}\n`);
      process.exit(1);
    }

    if (!opts.jsonl && !opts.session) {
      process.stderr.write(
        "[emerge-dashboard] Either --jsonl or --session is required.\n" +
          "  --jsonl <path>    Live tail mode\n" +
          "  --session <path>  Replay mode\n",
      );
      process.exit(1);
    }

    if (opts.jsonl && opts.session) {
      process.stderr.write("[emerge-dashboard] --jsonl and --session are mutually exclusive.\n");
      process.exit(1);
    }

    // Security warning for non-loopback binding
    if (host !== "127.0.0.1" && host !== "localhost") {
      process.stderr.write(
        `\n[emerge-dashboard] WARNING: binding to ${host} exposes this server to the network.\n  The WebSocket endpoint has NO authentication. Only use this in trusted environments.\n\n`,
      );
    }

    const sourcePath = (opts.jsonl ?? opts.session) as string;
    if (!existsSync(sourcePath)) {
      process.stderr.write(`[emerge-dashboard] File not found: ${sourcePath}\n`);
      process.exit(1);
    }

    const source =
      opts.jsonl !== undefined
        ? { kind: "jsonl-tail" as const, path: opts.jsonl }
        : { kind: "jsonl-replay" as const, path: opts.session as string };

    let handle: Awaited<ReturnType<typeof startServer>>;
    try {
      handle = await startServer({ port, host, source });
    } catch (err) {
      process.stderr.write(`[emerge-dashboard] Failed to start server: ${String(err)}\n`);
      process.exit(1);
    }

    const mode = source.kind === "jsonl-tail" ? "live tail" : "replay";
    process.stdout.write(
      `[emerge-dashboard] Server running — mode: ${mode}\n` +
        `  Open: http://${host}:${handle.port}\n` +
        `  WS:   ws://${host}:${handle.port}\n` +
        `  File: ${sourcePath}\n`,
    );

    // Graceful shutdown on SIGINT / SIGTERM
    const shutdown = async () => {
      process.stdout.write("\n[emerge-dashboard] Shutting down...\n");
      await handle.close();
      process.exit(0);
    };

    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });
  });

program.exitOverride((err) => {
  process.stderr.write(`[emerge-dashboard] ${err.message}\n`);
  process.exit(1);
});

program.parse(process.argv);
