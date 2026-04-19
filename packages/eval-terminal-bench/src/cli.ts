#!/usr/bin/env node
/**
 * emerge-tbench CLI — run a Terminal-Bench task locally.
 *
 * Usage:
 *   emerge-tbench run <task.yaml> [options]
 *
 * Options:
 *   --provider <id>   Provider id to use (must be configured via env vars).
 *                     Currently: "mock" (default, for testing).
 *   --sandbox <mode>  Sandbox mode: "inproc" (default) or "harbor" (Docker).
 *   --image <image>   Docker image for harbor mode (default: ubuntu:22.04).
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY  — enables Anthropic provider
 *   OPENAI_API_KEY     — enables OpenAI provider
 *
 * Exit codes:
 *   0  task completed with aligned verdict
 *   1  task completed with misaligned/failed verdict, or harness error
 *   2  task spec validation error
 */

import { MockProvider } from "@emerge/provider-mock";
import { runAcceptance } from "./acceptance-runner.js";
import { makeTerminalBenchBlueprint } from "./blueprint.js";
import type { SandboxMode } from "./session-builder.js";
import { loadTask } from "./task-loader.js";

interface CliOptions {
  taskFile: string;
  providerMode: "mock";
  sandboxMode: SandboxMode;
  harborImage: string;
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  const args = argv.slice(2); // drop node + script
  if (args[0] !== "run" || !args[1]) {
    printUsage();
    return null;
  }

  const opts: CliOptions = {
    taskFile: args[1],
    providerMode: "mock",
    sandboxMode: "inproc",
    harborImage: "ubuntu:22.04",
  };

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--sandbox" && next) {
      if (next !== "inproc" && next !== "harbor") {
        console.error(`Unknown sandbox mode: ${next}. Use "inproc" or "harbor".`);
        return null;
      }
      opts.sandboxMode = next as SandboxMode;
      i++;
    } else if (arg === "--image" && next) {
      opts.harborImage = next;
      i++;
    } else if (arg === "--provider") {
      // Future: support anthropic/openai via env vars
      i++;
    }
  }

  return opts;
}

function printUsage(): void {
  console.error("Usage: emerge-tbench run <task.yaml> [--sandbox inproc|harbor] [--image IMAGE]");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (!opts) {
    process.exit(2);
  }

  console.log(`[emerge-tbench] Loading task: ${opts.taskFile}`);

  const loadResult = await loadTask(opts.taskFile);
  if (!loadResult.ok) {
    console.error(`[emerge-tbench] Task load failed: ${loadResult.error.message}`);
    process.exit(2);
  }

  const task = loadResult.value;
  console.log(`[emerge-tbench] Task: ${task.spec.title} (${task.spec.difficulty})`);
  console.log(`[emerge-tbench] Goal: ${task.spec.goal}`);
  console.log(`[emerge-tbench] Workspace: ${task.workspaceRoot}`);
  console.log(`[emerge-tbench] Sandbox: ${opts.sandboxMode}`);

  // Register SIGINT/SIGTERM cleanup so Ctrl-C doesn't leave workspaces in
  // /tmp/.emerge-workspaces/. cleanup() is synchronous in effect (it schedules
  // async work) but we call it and wait 200ms to let the fs.rm settle before exit.
  const cleanupAndExit = (signal: string) => {
    console.log(`\n[emerge-tbench] ${signal} received — cleaning up workspace...`);
    void task.cleanup().then(() => {
      process.exit(130); // Standard exit code for signal termination
    });
    // Hard exit after 2 seconds in case cleanup hangs
    setTimeout(() => process.exit(130), 2000).unref();
  };
  process.once("SIGINT", () => cleanupAndExit("SIGINT"));
  process.once("SIGTERM", () => cleanupAndExit("SIGTERM"));

  // Mock provider script — two steps: read file, write fix, then end
  const provider = new MockProvider(
    [
      {
        events: [
          { type: "text_delta", text: "I'll read the file to understand the issue." },
          {
            type: "stop",
            reason: "end_turn",
            usage: { tokensIn: 50, tokensOut: 20, wallMs: 100, toolCalls: 0, usd: 0.001 },
          },
        ],
      },
    ],
    "mock",
  );

  const { session, agentSpec } = makeTerminalBenchBlueprint({
    spec: task.spec,
    workspaceRoot: task.workspaceRoot,
    provider,
    sandboxMode: opts.sandboxMode,
    harborImage: opts.harborImage,
  });

  try {
    console.log(`[emerge-tbench] Starting session ${session.sessionId}`);

    const spawnResult = await session.kernel.spawn(agentSpec);
    if (!spawnResult.ok) {
      console.error(`[emerge-tbench] Spawn failed: ${spawnResult.error.message}`);
      process.exit(1);
    }

    const handle = spawnResult.value;
    await session.kernel.runAgent(handle);

    console.log("[emerge-tbench] Agent loop complete");

    const acceptance = await runAcceptance(
      task.spec.acceptanceCommand,
      task.workspaceRoot,
      task.spec.timeoutSeconds,
    );

    console.log("\n[emerge-tbench] === Acceptance Result ===");
    console.log(`  Command: ${task.spec.acceptanceCommand}`);
    console.log(`  Exit code: ${acceptance.exitCode}`);
    console.log(`  Duration: ${acceptance.durationMs}ms`);
    console.log(`  Verdict: ${acceptance.verdict.kind}`);
    if (acceptance.stdout.trim()) {
      console.log(`  stdout:\n${acceptance.stdout.slice(0, 1000)}`);
    }
    if (acceptance.stderr.trim()) {
      console.log(`  stderr:\n${acceptance.stderr.slice(0, 500)}`);
    }

    session.stopAdjudicatorWatch();

    const endResult = await session.kernel.endSession();
    if (!endResult.ok) {
      // trustMode=explicit: may fail if no aligned verdict
      console.log(`[emerge-tbench] Session ended (verdict gate): ${endResult.error.message}`);
    } else {
      const costMeter = session.kernel.getCostMeter();
      const ledger = costMeter.ledger();
      console.log(`[emerge-tbench] Session cost: $${ledger.totals.grand.toFixed(6)}`);
    }

    // Exit based on acceptance result
    const passed = acceptance.verdict.kind === "aligned";
    console.log(`\n[emerge-tbench] Result: ${passed ? "PASS" : "FAIL"}`);
    process.exit(passed ? 0 : 1);
  } finally {
    await task.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error("[emerge-tbench] Fatal error:", err);
  process.exit(1);
});
