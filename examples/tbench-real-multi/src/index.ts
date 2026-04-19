/**
 * tbench-real-multi — Real-model multi-step bug-fix task.
 *
 * A small Python repo with 3 bugs across 2 files. The model must:
 *   1. Read both source files to understand the code
 *   2. Identify and fix bug #1 in src/math_utils.py (wrong operator in add_and_multiply)
 *   3. Identify and fix bug #2 in src/math_utils.py (off-by-one in bounded_sum)
 *   4. Identify and fix bug #3 in src/string_utils.py (wrong slice in truncate)
 *   5. Verify with bash: python3 -m pytest tests/ -x -q
 *
 * Expected tool call pattern: read × 2, write × 2, bash × 1 = ~5-6 tool calls.
 * This tests the model's ability to: read multiple files, understand multi-bug
 * context, write targeted fixes, and verify.
 *
 * Reasoning effort: medium (escalate to high if model gives up prematurely).
 *
 * Environment variables:
 *   OPENAI_API_KEY          — API key for the OpenAI-compatible gateway
 *   OPENAI_BASE_URL         — Base URL including /v1 (e.g. https://host/v1)
 *   OPENAI_MODEL            — Model name (e.g. gpt-5.4, gpt-4o)
 *   OPENAI_PROTOCOL         — "chat" | "responses" (default: "responses")
 *   OPENAI_REASONING_EFFORT — "minimal"|"low"|"medium"|"high"|"xhigh" (optional)
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  makeTerminalBenchBlueprint,
  materializeTask,
  runAcceptance,
} from "@emerge/eval-terminal-bench";
import { OpenAIProvider, openaiSchemaAdapter } from "@emerge/provider-openai";
import type { OpenAIProtocol, OpenAIReasoningConfig } from "@emerge/provider-openai";

// ─── Task spec: 3 bugs across 2 files ────────────────────────────────────────

const TASK_SPEC = {
  id: "real-multi-bug",
  title: "Fix three bugs across two Python files",
  repo: {
    kind: "inline" as const,
    files: {
      "src/__init__.py": "",
      "src/math_utils.py": `def add_and_multiply(a, b, factor):
    """Return (a + b) * factor."""
    # BUG 1: uses subtraction instead of addition
    return (a - b) * factor


def bounded_sum(numbers, limit):
    """Return sum of numbers, capped at limit."""
    total = 0
    # BUG 2: off-by-one — loop excludes the last element
    for n in numbers[:-1]:
        total += n
    return min(total, limit)
`,
      "src/string_utils.py": `def truncate(s, max_len):
    """Return s truncated to max_len characters."""
    if len(s) <= max_len:
        return s
    # BUG 3: off-by-one — should be s[:max_len] not s[:max_len-1]
    return s[:max_len - 1]


def capitalize_words(s):
    """Return s with each word capitalized."""
    return " ".join(word.capitalize() for word in s.split())
`,
      "tests/__init__.py": "",
      "tests/test_math_utils.py": `from src.math_utils import add_and_multiply, bounded_sum


def test_add_and_multiply():
    assert add_and_multiply(2, 3, 4) == 20   # (2+3)*4
    assert add_and_multiply(1, 1, 1) == 2    # (1+1)*1
    assert add_and_multiply(0, 5, 2) == 10   # (0+5)*2


def test_bounded_sum():
    assert bounded_sum([1, 2, 3, 4], 100) == 10  # 1+2+3+4 = 10
    assert bounded_sum([5, 5, 5], 12) == 12       # 15 capped at 12
    assert bounded_sum([1], 100) == 1             # single element
`,
      "tests/test_string_utils.py": `from src.string_utils import truncate, capitalize_words


def test_truncate():
    assert truncate("hello world", 5) == "hello"
    assert truncate("hi", 5) == "hi"         # no truncation needed
    assert truncate("abcde", 5) == "abcde"   # exactly at limit


def test_capitalize_words():
    assert capitalize_words("hello world") == "Hello World"
`,
    },
  },
  goal: `Fix three bugs so that all pytest tests pass:

1. In src/math_utils.py — add_and_multiply: uses subtraction (a - b) instead of addition (a + b).
2. In src/math_utils.py — bounded_sum: the loop uses numbers[:-1] (excludes last element) instead of numbers (includes all elements).
3. In src/string_utils.py — truncate: returns s[:max_len - 1] (one short) instead of s[:max_len].

Read both source files to understand the full picture before writing fixes.`,
  acceptanceCommand: "python3 -m pytest tests/ -x -q",
  timeoutSeconds: 180,
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
        "    node examples/tbench-real-multi/dist/index.js",
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

  const effectiveModel = model ?? "gpt-4o";

  console.log("=== tbench-real-multi — Real-model multi-step bug-fix task ===\n");
  console.log("Task: Fix 3 bugs across 2 Python files (math_utils.py + string_utils.py)");
  console.log("Bugs: BUG1=wrong operator, BUG2=off-by-one loop, BUG3=off-by-one slice");
  console.log(`Acceptance: ${TASK_SPEC.acceptanceCommand}`);
  console.log("Sandbox: inproc");
  console.log(`Model: ${effectiveModel} (protocol: ${protocol})`);
  if (reasoning !== undefined) {
    console.log(`Reasoning effort: ${reasoning.effort}`);
  }
  if (baseURL !== undefined) {
    console.log(`Base URL: ${baseURL}`);
  }
  console.log();

  const provider = new OpenAIProvider({
    apiKey,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(model !== undefined ? { model } : {}),
    protocol,
    ...(reasoning !== undefined ? { reasoning } : {}),
  });

  // 1. Materialize workspace
  const matResult = await materializeTask(TASK_SPEC);
  if (!matResult.ok) {
    console.error(`FATAL: Workspace materialization failed: ${matResult.error.message}`);
    process.exit(1);
  }

  const task = matResult.value;
  console.log(`Workspace: ${task.workspaceRoot}\n`);

  // Confirm all 3 bugs are present before run
  const mathContent = await fs.readFile(
    path.join(task.workspaceRoot, "src/math_utils.py"),
    "utf-8",
  );
  const strContent = await fs.readFile(
    path.join(task.workspaceRoot, "src/string_utils.py"),
    "utf-8",
  );
  const bug1Present = mathContent.includes("a - b");
  const bug2Present = mathContent.includes("numbers[:-1]");
  const bug3Present = strContent.includes("max_len - 1");
  console.log("Bugs present before run:");
  console.log(`  BUG1 (wrong operator in add_and_multiply): ${bug1Present ? "YES" : "NO"}`);
  console.log(`  BUG2 (off-by-one in bounded_sum): ${bug2Present ? "YES" : "NO"}`);
  console.log(`  BUG3 (off-by-one in truncate): ${bug3Present ? "YES" : "NO"}`);
  console.log();

  // 2. Wire blueprint
  const { session, agentSpec } = makeTerminalBenchBlueprint({
    spec: TASK_SPEC,
    workspaceRoot: task.workspaceRoot,
    provider,
    sandboxMode: "inproc",
    schemaAdapter: openaiSchemaAdapter,
    // Allow up to 25 iterations for a multi-bug task
    maxIterations: 25,
  });

  console.log(`Session: ${session.sessionId}`);
  console.log(`Provider ID: ${provider.capabilities.id}\n`);

  const runStart = Date.now();

  try {
    const spawnResult = await session.kernel.spawn(agentSpec);
    if (!spawnResult.ok) {
      console.error(`FATAL: Agent spawn failed: ${spawnResult.error.message}`);
      process.exit(1);
    }

    const handle = spawnResult.value;
    console.log(`Agent spawned: ${String(handle.id)}`);
    console.log("Running multi-step agent loop...\n");

    // 3. Run the agent loop
    await session.kernel.runAgent(handle);

    const snapshot = await handle.snapshot();
    const wallMs = Date.now() - runStart;

    console.log("Agent loop complete:");
    console.log(`  State:      ${snapshot.state}`);
    console.log(`  Tokens in:  ${snapshot.usage.tokensIn}`);
    console.log(`  Tokens out: ${snapshot.usage.tokensOut}`);
    console.log(`  USD:        $${snapshot.usage.usd.toFixed(4)}`);
    console.log(`  Wall time:  ${wallMs}ms`);

    // Estimate iterations from output tokens (rough heuristic)
    const iterEst =
      snapshot.usage.tokensOut > 0
        ? `~${Math.max(1, Math.ceil(snapshot.usage.tokensOut / 80))} model calls`
        : "unknown";
    console.log(`  Est. steps: ${iterEst}\n`);

    // 4. Check each bug was fixed
    const mathFixed = await fs.readFile(
      path.join(task.workspaceRoot, "src/math_utils.py"),
      "utf-8",
    );
    const strFixed = await fs.readFile(
      path.join(task.workspaceRoot, "src/string_utils.py"),
      "utf-8",
    );

    const fix1Applied = mathFixed.includes("a + b") && !mathFixed.includes("a - b");
    const fix2Applied = !mathFixed.includes("numbers[:-1]");
    const fix3Applied = !strFixed.includes("max_len - 1") || strFixed.includes("s[:max_len]");

    console.log("Bug fix check:");
    console.log(`  BUG1 fixed (a + b): ${fix1Applied ? "YES" : "NO"}`);
    console.log(`  BUG2 fixed (no [:-1]): ${fix2Applied ? "YES" : "NO"}`);
    console.log(`  BUG3 fixed (no max_len - 1): ${fix3Applied ? "YES" : "NO"}`);
    console.log();

    // 5. Run acceptance
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

    // 6. End session — kernel verdict gate
    await session.stopAdjudicatorWatch();
    const endResult = await session.kernel.endSession();

    if (!endResult.ok) {
      console.log(`\nSession end (verdict gate active): ${endResult.error.message}`);
    } else {
      const ledger = session.kernel.getCostMeter().ledger();
      console.log(`\nSession cost: $${ledger.totals.grand.toFixed(6)}`);
    }

    // 7. Final verdict
    const allBugsFixed = fix1Applied && fix2Applied && fix3Applied;
    const passed = acceptance.verdict.kind === "aligned" && allBugsFixed && endResult.ok;

    console.log(`\n=== FINAL RESULT: ${passed ? "PASS" : "FAIL"} ===`);

    // Partial credit reporting
    const fixCount = [fix1Applied, fix2Applied, fix3Applied].filter(Boolean).length;
    console.log(`\nBugs fixed: ${fixCount}/3`);

    if (!passed) {
      if (!endResult.ok) {
        console.error("\nKernel verdict gate refused: adjudicator did not emit aligned verdict.");
        console.error(`  Kernel error: ${endResult.error.message}`);
      }
      if (acceptance.verdict.kind !== "aligned") {
        console.error("\nStandalone acceptance failed — not all bugs were fixed correctly.");
        console.error(`  Verdict: ${acceptance.verdict.kind}`);
      }
      if (!allBugsFixed) {
        console.error("\nNot all bugs fixed:");
        if (!fix1Applied) console.error("  - BUG1 still present: a - b in add_and_multiply");
        if (!fix2Applied) console.error("  - BUG2 still present: numbers[:-1] in bounded_sum");
        if (!fix3Applied) console.error("  - BUG3 still present: max_len - 1 in truncate");
      }
      process.exit(1);
    }

    console.log("\nAll checks passed:");
    console.log("  - All 3 bugs fixed across 2 files");
    console.log("  - Acceptance command exited 0 (pytest passed)");
    console.log("  - Kernel verdict gate: adjudicator confirmed aligned verdict");
    console.log("\nMulti-step real-model Terminal-Bench run complete.");
  } finally {
    await task.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
