/**
 * tbench-smoke-inline — Task A self-test.
 *
 * A synthetic Terminal-Bench task using an inline-files spec (no network,
 * no Docker). Tests the full harness wiring:
 *   - TaskSpec parsing + workspace materialization
 *   - Kernel session + tool registration (fs.read, fs.write, bash)
 *   - Mock provider with a realistic "read → fix → verify" sequence
 *   - Acceptance runner (runs pytest, checks exit code)
 *   - Adjudicator verdict tracking
 *
 * The broken Python repo: src/util.py has `return a - b` instead of `return a + b`.
 * The mock provider sequence:
 *   Step 1: read src/util.py (sees the bug)
 *   Step 2: write the fix to src/util.py
 *   Step 3: run pytest to verify (bash tool)
 *   Step 4: end_turn
 *
 * Real provider mode: set ANTHROPIC_API_KEY or OPENAI_API_KEY to run
 * against a live model. Exits 0 with "SKIPPED" message if neither is set
 * and --real-provider is passed.
 *
 * Acceptance test: `python3 -m pytest tests/ -x -q`
 * Exit code 0 → aligned. Non-zero → misaligned.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializeTask } from "@emerge/eval-terminal-bench";
import { makeTerminalBenchBlueprint } from "@emerge/eval-terminal-bench";
import { runAcceptance } from "@emerge/eval-terminal-bench";
import type { AgentId, ProviderEvent, SessionId } from "@emerge/kernel/contracts";
import { MockProvider } from "@emerge/provider-mock";

// ─── Task spec ───────────────────────────────────────────────────────────────

const TASK_SPEC = {
  id: "smoke-inline-add-bug",
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
  timeoutSeconds: 60,
  difficulty: "trivial" as const,
};

// ─── Mock provider script ─────────────────────────────────────────────────────

function buildMockScript(workspaceRoot: string): readonly { events: readonly ProviderEvent[] }[] {
  const utilPath = path.join(workspaceRoot, "src/util.py");
  const fixedContent = `def add(a, b):
    return a + b


def multiply(a, b):
    return a * b
`;

  return [
    // Step 1: read the buggy file
    {
      events: [
        { type: "text_delta", text: "Let me read the source file to understand the bug." },
        { type: "tool_call_start", toolCallId: "tc-1", name: "fs.read" },
        {
          type: "tool_call_input_delta",
          toolCallId: "tc-1",
          partial: JSON.stringify({ path: utilPath }),
        },
        { type: "tool_call_end", toolCallId: "tc-1" },
        {
          type: "stop",
          reason: "tool_use",
          usage: { tokensIn: 80, tokensOut: 30, wallMs: 100, toolCalls: 1, usd: 0.001 },
        },
      ],
    },
    // Step 2: write the fix
    {
      events: [
        {
          type: "text_delta",
          text: "I can see the bug: `return a - b` should be `return a + b`. Let me fix it.",
        },
        { type: "tool_call_start", toolCallId: "tc-2", name: "fs.write" },
        {
          type: "tool_call_input_delta",
          toolCallId: "tc-2",
          partial: JSON.stringify({ path: utilPath, content: fixedContent }),
        },
        { type: "tool_call_end", toolCallId: "tc-2" },
        {
          type: "stop",
          reason: "tool_use",
          usage: { tokensIn: 200, tokensOut: 60, wallMs: 120, toolCalls: 1, usd: 0.002 },
        },
      ],
    },
    // Step 3: verify with pytest
    {
      events: [
        { type: "text_delta", text: "Now let me verify the fix with pytest." },
        { type: "tool_call_start", toolCallId: "tc-3", name: "bash" },
        {
          type: "tool_call_input_delta",
          toolCallId: "tc-3",
          partial: JSON.stringify({ cmd: "python3 -m pytest tests/ -x -q", cwd: workspaceRoot }),
        },
        { type: "tool_call_end", toolCallId: "tc-3" },
        {
          type: "stop",
          reason: "tool_use",
          usage: { tokensIn: 300, tokensOut: 40, wallMs: 200, toolCalls: 1, usd: 0.003 },
        },
      ],
    },
    // Step 4: done
    {
      events: [
        {
          type: "text_delta",
          text: "The tests pass. I fixed the bug by changing `return a - b` to `return a + b` in the add() function. The task is complete.",
        },
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 400, tokensOut: 50, wallMs: 80, toolCalls: 0, usd: 0.004 },
        },
      ],
    },
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== tbench-smoke-inline — Task A self-test ===\n");
  console.log("Task: Fix the broken add() function in src/util.py");
  console.log("Acceptance: python3 -m pytest tests/ -x -q");
  console.log("Sandbox: inproc (no Docker required)\n");

  // 1. Materialize the inline task spec into a workspace
  const matResult = await materializeTask(TASK_SPEC);
  if (!matResult.ok) {
    console.error(`FATAL: Workspace materialization failed: ${matResult.error.message}`);
    process.exit(1);
  }

  const task = matResult.value;
  console.log(`Workspace: ${task.workspaceRoot}`);

  // Verify the bug exists before running the agent
  const utilContent = await fs.readFile(path.join(task.workspaceRoot, "src/util.py"), "utf-8");
  const hasBug = utilContent.includes("return a - b");
  console.log(`Bug present before run: ${hasBug ? "YES (expected)" : "NO (unexpected!)"}`);

  // 2. Build the mock provider with the workspace-aware script
  const script = buildMockScript(task.workspaceRoot);
  const provider = new MockProvider(script, "mock-inline-smoke");

  // 3. Wire the blueprint
  const { session, agentSpec } = makeTerminalBenchBlueprint({
    spec: TASK_SPEC,
    workspaceRoot: task.workspaceRoot,
    provider,
    sandboxMode: "inproc",
  });

  console.log(`\nSession: ${session.sessionId}`);

  // 4. Run the agent
  const startTime = Date.now();

  try {
    const spawnResult = await session.kernel.spawn(agentSpec);
    if (!spawnResult.ok) {
      console.error(`FATAL: Agent spawn failed: ${spawnResult.error.message}`);
      process.exit(1);
    }

    const handle = spawnResult.value;
    console.log(`Agent spawned: ${String(handle.id)}`);
    console.log("Running agent loop...\n");

    await session.kernel.runAgent(handle);

    const snapshot = await handle.snapshot();
    const wallMs = Date.now() - startTime;

    console.log("\nAgent loop complete:");
    console.log(`  State: ${snapshot.state}`);
    console.log(`  Tokens in: ${snapshot.usage.tokensIn}`);
    console.log(`  Tokens out: ${snapshot.usage.tokensOut}`);
    console.log(`  Wall time: ${wallMs}ms`);

    // 5. Run acceptance tests
    console.log(`\nRunning acceptance command: ${TASK_SPEC.acceptanceCommand}`);
    const acceptance = await runAcceptance(
      TASK_SPEC.acceptanceCommand,
      task.workspaceRoot,
      TASK_SPEC.timeoutSeconds,
    );

    console.log("\n=== Acceptance Result ===");
    console.log(`  Exit code: ${acceptance.exitCode}`);
    console.log(`  Duration: ${acceptance.durationMs}ms`);
    console.log(`  Verdict: ${acceptance.verdict.kind}`);
    if (acceptance.stdout.trim()) {
      console.log(`  stdout:\n${acceptance.stdout}`);
    }
    if (acceptance.stderr.trim()) {
      console.log(`  stderr:\n${acceptance.stderr}`);
    }

    // 6. Check the fix was actually applied
    const fixedContent = await fs.readFile(path.join(task.workspaceRoot, "src/util.py"), "utf-8");
    const bugFixed =
      fixedContent.includes("return a + b") && !fixedContent.includes("return a - b");
    console.log(`\nBug fixed: ${bugFixed ? "YES" : "NO"}`);

    // 7. End session
    await session.stopAdjudicatorWatch();
    const endResult = await session.kernel.endSession();
    if (!endResult.ok) {
      // With trustMode=explicit, endSession fails unless the adjudicator emits an aligned verdict.
      // The adjudicator watches bus for result envelopes from the agent — in this mock run,
      // the agent emits a result envelope at the end. The acceptance command determines the verdict.
      console.log(`\nSession end (verdict gate active): ${endResult.error.message}`);
    } else {
      const ledger = session.kernel.getCostMeter().ledger();
      console.log(`\nSession cost: $${ledger.totals.grand.toFixed(6)}`);
    }

    // Final — honest gate: standalone acceptance + bug-fixed AND kernel verdict gate must agree.
    const passed = acceptance.verdict.kind === "aligned" && bugFixed && endResult.ok;
    console.log(`\n=== FINAL RESULT: ${passed ? "PASS" : "FAIL"} ===`);

    if (!endResult.ok) {
      console.error("\nASSERTION: Kernel verdict gate refused to mark session completed.");
      console.error("The Adjudicator-mounted acceptance run disagrees with the standalone one,");
      console.error("or no aligned verdict reached the kernel before endSession().");
      process.exit(1);
    }

    if (!passed) {
      console.error("\nASSERTION: Expected aligned verdict but acceptance failed.");
      console.error("This means the mock provider did not correctly fix the bug.");
      process.exit(1);
    }

    if (!bugFixed) {
      console.error("\nASSERTION: Bug was not fixed in src/util.py.");
      process.exit(1);
    }

    console.log("\nAll assertions passed. Task A smoke test complete.");
    console.log("\nReal provider test:");
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature
    if (process.env["ANTHROPIC_API_KEY"]) {
      console.log(
        "  ANTHROPIC_API_KEY is set — set EMERGE_REAL_PROVIDER=1 to run against Anthropic",
      );
    } else {
      console.log("  Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable real provider tests.");
    }
  } finally {
    await task.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
