/**
 * tbench-real-replay — Two-phase real-model record-then-replay demo.
 *
 * Phase 1 (record): Run the same add() bug task as tbench-real-inline.
 *   Records all provider_call events via makeRecorder() attached to the kernel
 *   through the `recorder` option in SessionBuilderOptions.
 *   A real provider call is made; the SessionRecord is captured from endSession().
 *
 * Phase 2 (replay): Build a second session with replayRecord + replayProviderFactory
 *   in SessionBuilderOptions. The kernel is set to reproducibility:"record-replay".
 *   The RecordedProvider intercepts every invoke() — NO real API calls happen.
 *   cost.totals.grand = $0 from the kernel's perspective during replay.
 *   File-write side effects DO happen (the fix is applied again to a fresh workspace).
 *
 * Validates the dual-thesis claim: "recorded sessions replay exactly."
 * This is the most strategically important of the three validation tracks.
 *
 * Harness bugs fixed to enable this track:
 *   - buildSession(): added `recorder` option (enables Phase 1 recording)
 *   - buildSession(): added `replayRecord` + `replayProviderFactory` options
 *     (enables Phase 2 replay with reproducibility:"record-replay")
 *
 * Environment variables (required for Phase 1; Phase 2 always runs from record):
 *   OPENAI_API_KEY          — API key for the OpenAI-compatible gateway
 *   OPENAI_BASE_URL         — Base URL including /v1 (e.g. https://host/v1)
 *   OPENAI_MODEL            — Model name (e.g. gpt-5.4, gpt-4o)
 *   OPENAI_PROTOCOL         — "chat" | "responses" (default: "responses")
 *   OPENAI_REASONING_EFFORT — "minimal"|"low"|"medium"|"high"|"xhigh" (optional)
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  buildSession,
  makeTerminalBenchBlueprint,
  materializeTask,
  runAcceptance,
} from "@lwrf42/emerge-eval-terminal-bench";
import type { Provider, SessionRecord } from "@lwrf42/emerge-kernel/contracts";
import { OpenAIProvider, openaiSchemaAdapter } from "@lwrf42/emerge-provider-openai";
import type { OpenAIProtocol, OpenAIReasoningConfig } from "@lwrf42/emerge-provider-openai";
import { RecordedProvider, makeRecorder } from "@lwrf42/emerge-replay";

// ─── Task spec (identical to tbench-real-inline Task A) ─────────────────────

const TASK_SPEC = {
  id: "real-replay-add-bug",
  title: "Fix the broken add function (record-replay demo)",
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

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const apiKey = process.env["OPENAI_API_KEY"];

  if (!apiKey) {
    console.log(
      "[skipped: OPENAI_API_KEY not set]\n" +
        "Run with:\n" +
        "  OPENAI_API_KEY=sk-... OPENAI_BASE_URL=https://host/v1 OPENAI_MODEL=gpt-5.4 \\\n" +
        "    OPENAI_PROTOCOL=responses OPENAI_REASONING_EFFORT=medium \\\n" +
        "    node examples/tbench-real-replay/dist/index.js",
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

  console.log("=== tbench-real-replay — Real-model record + replay demo ===\n");
  console.log("Task: Fix the broken add() function in src/util.py");
  console.log("Phases: 1=record (real model), 2=replay (RecordedProvider — no API calls)");
  console.log(`Model: ${effectiveModel} (protocol: ${protocol})`);
  if (reasoning !== undefined) {
    console.log(`Reasoning effort: ${reasoning.effort}`);
  }
  if (baseURL !== undefined) {
    console.log(`Base URL: ${baseURL}`);
  }
  console.log();

  // Create provider (used in both phases — Phase 2 mounts it but never calls it)
  const provider = new OpenAIProvider({
    apiKey,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(model !== undefined ? { model } : {}),
    protocol,
    ...(reasoning !== undefined ? { reasoning } : {}),
  });

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 1: Record
  // ──────────────────────────────────────────────────────────────────────────

  console.log("=== Phase 1: Record (real model call) ===\n");

  const mat1Result = await materializeTask(TASK_SPEC);
  if (!mat1Result.ok) {
    console.error(`FATAL: Phase 1 workspace materialization failed: ${mat1Result.error.message}`);
    process.exit(1);
  }
  const task1 = mat1Result.value;
  console.log(`Phase 1 workspace: ${task1.workspaceRoot}`);

  // Verify bug present before Phase 1
  const util1Before = await fs.readFile(path.join(task1.workspaceRoot, "src/util.py"), "utf-8");
  console.log(`Bug present before Phase 1: ${util1Before.includes("return a - b") ? "YES" : "NO"}`);

  // Create recorder (in-memory; no file needed for this demo)
  const recorder = makeRecorder();

  const phase1Start = Date.now();
  let phase1Record: SessionRecord | undefined;

  try {
    // Build Phase 1 blueprint with recorder attached
    const { session, agentSpec } = makeTerminalBenchBlueprint({
      spec: TASK_SPEC,
      workspaceRoot: task1.workspaceRoot,
      provider,
      sandboxMode: "inproc",
      schemaAdapter: openaiSchemaAdapter,
      maxIterations: 20,
      recorder,
    });

    console.log(`Session: ${session.sessionId}`);

    const spawnResult = await session.kernel.spawn(agentSpec);
    if (!spawnResult.ok) {
      console.error(`FATAL: Agent spawn failed: ${spawnResult.error.message}`);
      process.exit(1);
    }

    const handle = spawnResult.value;
    console.log(`Agent spawned: ${String(handle.id)}`);
    console.log("Running Phase 1 agent loop...\n");

    await session.kernel.runAgent(handle);

    const snapshot = await handle.snapshot();
    const wallMs = Date.now() - phase1Start;

    console.log("Phase 1 agent loop complete:");
    console.log(`  State:      ${snapshot.state}`);
    console.log(`  Tokens in:  ${snapshot.usage.tokensIn}`);
    console.log(`  Tokens out: ${snapshot.usage.tokensOut}`);
    console.log(`  USD:        $${snapshot.usage.usd.toFixed(4)}`);
    console.log(`  Wall time:  ${wallMs}ms`);

    // Check bug was fixed in Phase 1
    const util1After = await fs.readFile(path.join(task1.workspaceRoot, "src/util.py"), "utf-8");
    const p1BugFixed = util1After.includes("return a + b") && !util1After.includes("return a - b");
    console.log(`\nBug fixed in Phase 1: ${p1BugFixed ? "YES" : "NO"}`);

    // Run acceptance to confirm Phase 1 result
    const acceptance1 = await runAcceptance(
      TASK_SPEC.acceptanceCommand,
      task1.workspaceRoot,
      TASK_SPEC.timeoutSeconds,
    );
    console.log(`Phase 1 acceptance: ${acceptance1.verdict.kind} (exit ${acceptance1.exitCode})`);
    if (acceptance1.stdout.trim()) {
      console.log(`  stdout: ${acceptance1.stdout.trim()}`);
    }

    // End Phase 1 session — recorder.end() is called internally; record returned
    await session.stopAdjudicatorWatch();
    const endResult1 = await session.kernel.endSession();

    if (!endResult1.ok) {
      console.error(`Phase 1 kernel verdict gate failed: ${endResult1.error.message}`);
      process.exit(1);
    }

    // Extract the session record
    phase1Record = endResult1.value.record;

    if (!phase1Record) {
      console.error(
        "FATAL: Phase 1 endSession returned no record — recorder was not attached to kernel.\n" +
          "This indicates a harness bug in the recorder injection path.",
      );
      process.exit(1);
    }

    const p1ProviderCalls = phase1Record.events.filter((e) => e.kind === "provider_call").length;
    const p1Cost = session.kernel.getCostMeter().ledger().totals.grand;

    console.log("\nPhase 1 SessionRecord captured:");
    console.log(`  Session ID: ${String(phase1Record.sessionId)}`);
    console.log(`  Total events: ${phase1Record.events.length}`);
    console.log(`  provider_call events: ${p1ProviderCalls}`);
    console.log(`  Phase 1 cost: $${p1Cost.toFixed(6)}`);

    if (acceptance1.verdict.kind !== "aligned") {
      console.error("Phase 1: bug not fixed — cannot produce a valid session for replay");
      process.exit(1);
    }
  } finally {
    await task1.cleanup();
  }

  if (!phase1Record) {
    console.error("FATAL: Phase 1 record not captured");
    process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 2: Replay
  // ──────────────────────────────────────────────────────────────────────────

  console.log("\n=== Phase 2: Replay (RecordedProvider — NO real API calls) ===\n");

  // Materialize a fresh Phase 2 workspace (starts with the original buggy code)
  const mat2Result = await materializeTask(TASK_SPEC);
  if (!mat2Result.ok) {
    console.error(`FATAL: Phase 2 workspace materialization failed: ${mat2Result.error.message}`);
    process.exit(1);
  }
  const task2 = mat2Result.value;
  console.log(`Phase 2 workspace: ${task2.workspaceRoot}`);

  // Verify Phase 2 workspace starts with the bug
  const util2Before = await fs.readFile(path.join(task2.workspaceRoot, "src/util.py"), "utf-8");
  console.log(
    `Bug present before Phase 2: ${util2Before.includes("return a - b") ? "YES (correct — fresh workspace)" : "NO (unexpected!)"}`,
  );

  const phase2Start = Date.now();
  let phase2Passed = false;

  try {
    // RecordedProvider factory — replays events without real HTTP calls
    const replayProviderFactory = (rec: SessionRecord, original: Provider): Provider =>
      new RecordedProvider(rec, original.capabilities);

    // Build Phase 2 session with replay options.
    // buildSession() sets reproducibility:"record-replay" when replayRecord is provided.
    const session2 = buildSession({
      spec: {
        ...TASK_SPEC,
        id: "real-replay-add-bug-phase2",
      },
      workspaceRoot: task2.workspaceRoot,
      provider,
      sandboxMode: "inproc",
      schemaAdapter: openaiSchemaAdapter,
      replayRecord: phase1Record,
      replayProviderFactory,
    });

    // Build Phase 2 agent spec using the same blueprint structure
    const { agentSpec: replayAgentSpec } = makeTerminalBenchBlueprint({
      spec: {
        ...TASK_SPEC,
        id: "real-replay-add-bug-phase2",
      },
      workspaceRoot: task2.workspaceRoot,
      provider,
      sandboxMode: "inproc",
      schemaAdapter: openaiSchemaAdapter,
      maxIterations: 20,
    });

    // Fix up agent spec to use Phase 2's session agent id
    const phase2AgentSpec = {
      ...replayAgentSpec,
      id: session2.agentId,
    };

    console.log(`Session: ${session2.sessionId}`);

    const spawnResult2 = await session2.kernel.spawn(phase2AgentSpec);
    if (!spawnResult2.ok) {
      console.error(`FATAL: Phase 2 agent spawn failed: ${spawnResult2.error.message}`);
      process.exit(1);
    }

    const handle2 = spawnResult2.value;
    console.log(`Agent spawned: ${String(handle2.id)}`);
    console.log("Running Phase 2 agent loop (RecordedProvider intercepts all provider calls)...\n");

    await session2.kernel.runAgent(handle2);

    const snapshot2 = await handle2.snapshot();
    const wallMs2 = Date.now() - phase2Start;

    console.log("Phase 2 agent loop complete:");
    console.log(`  State:      ${snapshot2.state}`);
    console.log(`  Tokens in:  ${snapshot2.usage.tokensIn}`);
    console.log(`  Tokens out: ${snapshot2.usage.tokensOut}`);
    console.log(`  Wall time:  ${wallMs2}ms`);

    // Phase 2 cost MUST be $0 (no real provider calls)
    const ledger2 = session2.kernel.getCostMeter().ledger();
    const phase2Cost = ledger2.totals.grand;
    console.log(`  Phase 2 cost: $${phase2Cost.toFixed(6)} (must be $0.000000)`);

    // Check if the fix was applied during replay (file-write side effects replayed)
    const util2After = await fs.readFile(path.join(task2.workspaceRoot, "src/util.py"), "utf-8");
    const p2BugFixed = util2After.includes("return a + b") && !util2After.includes("return a - b");
    console.log(`\nBug fixed in Phase 2 (replay): ${p2BugFixed ? "YES" : "NO"}`);
    if (!p2BugFixed) {
      console.log(`  File content:\n${util2After}`);
    }

    // Run acceptance on Phase 2 workspace
    const acceptance2 = await runAcceptance(
      TASK_SPEC.acceptanceCommand,
      task2.workspaceRoot,
      TASK_SPEC.timeoutSeconds,
    );
    console.log(`Phase 2 acceptance: ${acceptance2.verdict.kind} (exit ${acceptance2.exitCode})`);
    if (acceptance2.stdout.trim()) {
      console.log(`  stdout: ${acceptance2.stdout.trim()}`);
    }

    // End Phase 2 session — verdict gate
    await session2.stopAdjudicatorWatch();
    const endResult2 = await session2.kernel.endSession();

    if (!endResult2.ok) {
      console.log(`Phase 2 verdict gate: FAILED — ${endResult2.error.message}`);
    } else {
      console.log("Phase 2 verdict gate: PASSED");
    }

    // Round-trip criteria:
    //   1. Phase 2 cost = $0 (no real provider calls made)
    //   2. Bug fixed in Phase 2 workspace (file-write side effects replayed)
    //   3. Acceptance command passes
    //   4. Verdict gate passed
    phase2Passed =
      phase2Cost === 0 && p2BugFixed && acceptance2.verdict.kind === "aligned" && endResult2.ok;

    console.log("\n=== Round-trip Evidence ===");
    console.log(
      `Phase 1 provider calls (real): ${phase1Record.events.filter((e) => e.kind === "provider_call").length}`,
    );
    console.log(
      "Phase 2 provider calls (real): 0 (RecordedProvider intercepted all invoke() calls)",
    );
    console.log(
      `Phase 2 file side-effects: ${p2BugFixed ? "replayed correctly (bug fixed again)" : "NOT replayed"}`,
    );
    console.log(`Phase 2 cost: $${phase2Cost.toFixed(6)}`);
  } finally {
    await task2.cleanup();
  }

  // ─── Final verdict ────────────────────────────────────────────────────────

  console.log(`\n=== FINAL RESULT: ${phase2Passed ? "PASS" : "FAIL"} ===`);

  if (phase2Passed) {
    console.log("\nAll checks passed:");
    console.log("  - Phase 1: real model ran, fixed bug, adjudicator aligned");
    console.log(
      `  - Phase 1: SessionRecord captured (${phase1Record.events.filter((e) => e.kind === "provider_call").length} provider_call events)`,
    );
    console.log("  - Phase 2: RecordedProvider replayed without real API calls");
    console.log("  - Phase 2: same file-write side-effects reproduced (bug fixed again)");
    console.log("  - Phase 2: acceptance command passed");
    console.log("  - cost.totals.grand = $0.000000 during Phase 2 replay");
    console.log("\nRecord-replay reproducibility tier validated.");
  } else {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
