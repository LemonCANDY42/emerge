/**
 * tbench-real-inline — FIRST real-model Terminal-Bench end-to-end run.
 *
 * Same add() bug task as tbench-smoke-inline, but using OpenAIProvider instead
 * of MockProvider. Exercises the full harness path:
 *   - TaskSpec parsing + workspace materialization
 *   - makeTerminalBenchBlueprint (surveillance, adjudicator, verdict gate, autoPermission, baseDir)
 *   - Real model: reads files, understands the bug, writes the fix, runs pytest
 *   - Acceptance runner: python3 -m pytest tests/ -x -q
 *   - Kernel verdict gate: endSession() must see an aligned adjudicator verdict
 *
 * Environment variables (required to run; exits 0 with skip message if absent):
 *   OPENAI_API_KEY          — API key for the OpenAI-compatible gateway
 *   OPENAI_BASE_URL         — Base URL including /v1 (e.g. https://gmn.example.com/v1)
 *   OPENAI_MODEL            — Model name (e.g. gpt-5.4, gpt-4o)
 *   OPENAI_PROTOCOL         — "chat" | "responses" (default: "responses")
 *   OPENAI_REASONING_EFFORT — "minimal"|"low"|"medium"|"high"|"xhigh" (optional)
 *
 * This is the FIRST real-model run through the full harness. Bugs found here
 * are documented in M4-REAL-PROVIDER-REPORT.md at repo root.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  makeTerminalBenchBlueprint,
  materializeTask,
  runAcceptance,
} from "@lwrf42/emerge-eval-terminal-bench";
import { OpenAIProvider, openaiSchemaAdapter } from "@lwrf42/emerge-provider-openai";
import type { OpenAIProtocol, OpenAIReasoningConfig } from "@lwrf42/emerge-provider-openai";

// ─── Task spec (identical to tbench-smoke-inline Task A) ─────────────────────

const TASK_SPEC = {
  id: "real-inline-add-bug",
  title: "Fix the broken add function",
  repo: {
    kind: "inline" as const,
    files: {
      "src/__init__.py": "",
      "src/util.py": `def add(a, b):
    # BUG: subtraction instead of addition
    return a - b


def multiply(a, b):
    return a * b
`,
      "tests/__init__.py": "",
      "tests/test_util.py": `from src.util import add, multiply


def test_add():
    assert add(1, 2) == 3
    assert add(0, 0) == 0
    assert add(-1, 1) == 0


def test_multiply():
    assert multiply(2, 3) == 6
`,
    },
  },
  goal: "Fix the bug in src/util.py so that pytest tests/ passes. The add() function currently returns a - b instead of a + b.",
  acceptanceCommand: "python3 -m pytest tests/ -x -q",
  timeoutSeconds: 120,
  difficulty: "trivial" as const,
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const apiKey = process.env["OPENAI_API_KEY"];

  if (!apiKey) {
    console.log(
      "[skipped: OPENAI_API_KEY not set]\n" +
        "Run with:\n" +
        "  OPENAI_API_KEY=sk-... OPENAI_BASE_URL=https://host/v1 OPENAI_MODEL=gpt-5.4 \\\n" +
        "    OPENAI_PROTOCOL=responses OPENAI_REASONING_EFFORT=medium \\\n" +
        "    node examples/tbench-real-inline/dist/index.js",
    );
    process.exit(0);
  }

  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const baseURL = process.env["OPENAI_BASE_URL"];
  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const model = process.env["OPENAI_MODEL"];
  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const protocolEnv = process.env["OPENAI_PROTOCOL"];
  const protocol: OpenAIProtocol = protocolEnv === "chat" ? "chat" : "responses";

  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const reasoningEffortEnv = process.env["OPENAI_REASONING_EFFORT"] as
    | OpenAIReasoningConfig["effort"]
    | undefined;
  const reasoning: OpenAIReasoningConfig | undefined =
    reasoningEffortEnv !== undefined ? { effort: reasoningEffortEnv } : undefined;

  const provider = new OpenAIProvider({
    apiKey,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(model !== undefined ? { model } : {}),
    protocol,
    ...(reasoning !== undefined ? { reasoning } : {}),
  });

  const modelId = provider.capabilities.id;
  const effectiveModel = model ?? "gpt-4o";

  console.log("=== tbench-real-inline — FIRST real-model Terminal-Bench run ===\n");
  console.log("Task: Fix the broken add() function in src/util.py");
  console.log(`Acceptance: ${TASK_SPEC.acceptanceCommand}`);
  console.log("Sandbox: inproc (no Docker required)");
  console.log(`Model: ${effectiveModel} (protocol: ${protocol})`);
  if (reasoning !== undefined) {
    console.log(`Reasoning effort: ${reasoning.effort}`);
  }
  if (baseURL !== undefined) {
    console.log(`Base URL: ${baseURL}`);
  }
  console.log();

  // 1. Materialize the inline task spec into a temp workspace
  const matResult = await materializeTask(TASK_SPEC);
  if (!matResult.ok) {
    console.error(`FATAL: Workspace materialization failed: ${matResult.error.message}`);
    process.exit(1);
  }

  const task = matResult.value;
  console.log(`Workspace: ${task.workspaceRoot}`);

  // Confirm the bug is present before running
  const utilContent = await fs.readFile(path.join(task.workspaceRoot, "src/util.py"), "utf-8");
  const hasBug = utilContent.includes("return a - b");
  console.log(`Bug present before run: ${hasBug ? "YES (expected)" : "NO (unexpected!)"}\n`);

  // 2. Wire blueprint: surveillance + adjudicator + verdict gate + autoPermission + baseDir
  const { session, agentSpec } = makeTerminalBenchBlueprint({
    spec: TASK_SPEC,
    workspaceRoot: task.workspaceRoot,
    provider,
    sandboxMode: "inproc",
    schemaAdapter: openaiSchemaAdapter,
    // Give the real model 20 iterations and 2 min wall time
    maxIterations: 20,
  });

  console.log(`Session: ${session.sessionId}`);
  console.log(`Provider ID: ${modelId}\n`);

  const runStart = Date.now();

  try {
    const spawnResult = await session.kernel.spawn(agentSpec);
    if (!spawnResult.ok) {
      console.error(`FATAL: Agent spawn failed: ${spawnResult.error.message}`);
      process.exit(1);
    }

    const handle = spawnResult.value;
    console.log(`Agent spawned: ${String(handle.id)}`);
    console.log("Running perceive → decide → act → observe loop...\n");

    // 3. Run the agent loop — real model calls happen here
    await session.kernel.runAgent(handle);

    const snapshot = await handle.snapshot();
    const wallMs = Date.now() - runStart;

    console.log("Agent loop complete:");
    console.log(`  State:      ${snapshot.state}`);
    console.log(`  Tokens in:  ${snapshot.usage.tokensIn}`);
    console.log(`  Tokens out: ${snapshot.usage.tokensOut}`);
    console.log(`  USD:        $${snapshot.usage.usd.toFixed(4)}`);
    console.log(`  Wall time:  ${wallMs}ms`);

    // Summarize step count from usage (iterations = tool calls + 1)
    const iterEst =
      snapshot.usage.tokensIn > 0
        ? `~${Math.max(1, Math.ceil(snapshot.usage.tokensOut / 100))} model calls`
        : "unknown";
    console.log(`  Est. steps: ${iterEst}\n`);

    // 4. Run standalone acceptance check (for reporting; adjudicator also ran one)
    console.log(`Running acceptance command: ${TASK_SPEC.acceptanceCommand}`);
    const acceptance = await runAcceptance(
      TASK_SPEC.acceptanceCommand,
      task.workspaceRoot,
      TASK_SPEC.timeoutSeconds,
    );

    console.log("\n=== Acceptance Result ===");
    console.log(`  Exit code: ${acceptance.exitCode}`);
    console.log(`  Duration:  ${acceptance.durationMs}ms`);
    console.log(`  Verdict:   ${acceptance.verdict.kind}`);
    if (acceptance.stdout.trim()) {
      console.log(`  stdout:\n${acceptance.stdout}`);
    }
    if (acceptance.stderr.trim()) {
      console.log(`  stderr:\n${acceptance.stderr}`);
    }

    // 5. Check whether the fix was actually applied to the file
    const fixedContent = await fs.readFile(path.join(task.workspaceRoot, "src/util.py"), "utf-8");
    const bugFixed =
      fixedContent.includes("return a + b") && !fixedContent.includes("return a - b");
    console.log(`\nBug fixed (file diff check): ${bugFixed ? "YES" : "NO"}`);

    // 6. End session — kernel verdict gate: requires adjudicator aligned verdict
    await session.stopAdjudicatorWatch();
    const endResult = await session.kernel.endSession();

    if (!endResult.ok) {
      console.log(`\nSession end (verdict gate active): ${endResult.error.message}`);
    } else {
      const ledger = session.kernel.getCostMeter().ledger();
      console.log(`\nSession cost: $${ledger.totals.grand.toFixed(6)}`);
    }

    // 7. Final verdict — all three conditions must be true
    const passed = acceptance.verdict.kind === "aligned" && bugFixed && endResult.ok;
    console.log(`\n=== FINAL RESULT: ${passed ? "PASS" : "FAIL"} ===`);

    if (!passed) {
      if (!endResult.ok) {
        console.error(
          "\nKernel verdict gate refused: adjudicator did not emit an aligned verdict.",
        );
        console.error(`  Kernel error: ${endResult.error.message}`);
      }
      if (acceptance.verdict.kind !== "aligned") {
        console.error("\nStandalone acceptance failed — the fix was not applied correctly.");
        console.error(`  Verdict: ${acceptance.verdict.kind}`);
      }
      if (!bugFixed) {
        console.error("\nFile content check: src/util.py still contains the bug.");
        console.error(`  Content preview: ${fixedContent.slice(0, 200)}`);
      }
      process.exit(1);
    }

    console.log("\nAll checks passed:");
    console.log("  - Bug fixed in src/util.py (file content check)");
    console.log("  - Acceptance command exited 0 (pytest passed)");
    console.log("  - Kernel verdict gate: adjudicator confirmed aligned verdict");
    console.log("\nFirst real-model Terminal-Bench run complete.");
  } finally {
    await task.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
