/**
 * emerge dashboard — passthrough subcommand.
 *
 * Shells out to `emerge-dashboard` binary rather than duplicating the full
 * server startup logic. This keeps @emerge/cli free of Node HTTP / ws deps.
 *
 * Usage:
 *   emerge dashboard --session <path>     replay mode
 *   emerge dashboard --jsonl <path>       live tail mode
 *   emerge dashboard --port 8080          custom port
 *   emerge dashboard --listen 0.0.0.0     network-exposed (with warning)
 *
 * The emerge-dashboard binary is expected at the same node_modules/.bin/
 * path that pnpm wires when @emerge/dashboard is installed. In the monorepo
 * it is resolved via workspace links.
 *
 * See docs/cli/dashboard.md for the full documentation.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

export interface DashboardOptions {
  readonly session?: string;
  readonly jsonl?: string;
  readonly port?: string;
  readonly listen?: string;
}

export async function dashboardCommand(options: DashboardOptions): Promise<void> {
  // Resolve emerge-dashboard bin — try the workspace-linked dist first,
  // then fall back to node_modules/.bin/emerge-dashboard for installed setups.
  let dashboardBin: string;
  try {
    // In monorepo: resolve via package.json#exports of @emerge/dashboard
    const pkgPath = require.resolve("@emerge/dashboard/package.json");
    const pkg = require("@emerge/dashboard/package.json") as { bin?: Record<string, string> };
    const relBin = pkg.bin?.["emerge-dashboard"];
    if (!relBin) throw new Error("No emerge-dashboard bin entry");
    dashboardBin = join(pkgPath, "..", relBin);
  } catch {
    // Fallback: assume it's on PATH
    dashboardBin = "emerge-dashboard";
  }

  const args: string[] = [];
  if (options.session !== undefined) {
    args.push("--session", options.session);
  }
  if (options.jsonl !== undefined) {
    args.push("--jsonl", options.jsonl);
  }
  if (options.port !== undefined) {
    args.push("--port", options.port);
  }
  if (options.listen !== undefined) {
    args.push("--listen", options.listen);
  }

  if (args.length === 0) {
    process.stderr.write(
      "[emerge dashboard] Either --session or --jsonl is required.\n" +
        "  emerge dashboard --session <path>   replay a recorded session\n" +
        "  emerge dashboard --jsonl <path>     tail a live session\n",
    );
    process.exit(1);
  }

  const isNodeBin = dashboardBin.endsWith(".js");
  const cmd = isNodeBin ? "node" : dashboardBin;
  const cmdArgs = isNodeBin ? [dashboardBin, ...args] : args;

  const child = spawn(cmd, cmdArgs, {
    stdio: "inherit",
    shell: false,
  });

  child.on("error", (err) => {
    process.stderr.write(
      `[emerge dashboard] Failed to start emerge-dashboard: ${String(err)}\n  Make sure @emerge/dashboard is built: pnpm --filter @emerge/dashboard build\n`,
    );
    process.exit(1);
  });

  // Wait for the child to exit and forward its exit code
  await new Promise<void>((resolve) => {
    child.on("close", (code) => {
      process.exit(code ?? 0);
      resolve();
    });
  });
}
