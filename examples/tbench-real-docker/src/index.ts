/**
 * tbench-real-docker — Real-model + Docker sandbox Terminal-Bench run.
 *
 * Mirrors tbench-real-inline but uses HarborSandbox (python:3.12-slim) for
 * the agent's bash tool calls. Same reverse_string() bug task as
 * tbench-smoke-docker (Task B), but with the real provider instead of
 * MockProvider.
 *
 * This is the first exercise of HarborSandbox + real provider together.
 * Per the pre-publish validation plan, 1-2 bugs at this boundary are expected.
 *
 * Environment variables (required to run; exits 0 with skip message if absent):
 *   OPENAI_API_KEY          — API key for the OpenAI-compatible gateway
 *   OPENAI_BASE_URL         — Base URL including /v1 (e.g. https://host/v1)
 *   OPENAI_MODEL            — Model name (e.g. gpt-5.4, gpt-4o)
 *   OPENAI_PROTOCOL         — "chat" | "responses" (default: "responses")
 *   OPENAI_REASONING_EFFORT — "minimal"|"low"|"medium"|"high"|"xhigh" (optional)
 *
 * Docker must be available: `docker --version` must succeed.
 *
 * Acceptance: python3 -m pytest tests/ -x -q (run on host via acceptanceSandbox: { kind: "host" })
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  makeTerminalBenchBlueprint,
  materializeTask,
  runAcceptance,
} from "@lwrf42/emerge-eval-terminal-bench";
import { OpenAIProvider, openaiSchemaAdapter } from "@lwrf42/emerge-provider-openai";
import type { OpenAIProtocol, OpenAIReasoningConfig } from "@lwrf42/emerge-provider-openai";

// ─── Task spec (same as tbench-smoke-docker) ─────────────────────────────────

const DOCKER_IMAGE = "python:3.12-slim";

const TASK_SPEC = {
  id: "real-docker-string-bug",
  title: "Fix the broken string reversal function",
  repo: {
    kind: "inline" as const,
    files: {
      "src/__init__.py": "",
      "src/strings.py": `def reverse_string(s: str) -> str:
    # BUG: returns original instead of reversed
    return s


def to_upper(s: str) -> str:
    return s.upper()
`,
      "tests/__init__.py": "",
      "tests/test_strings.py": `from src.strings import reverse_string, to_upper


def test_reverse():
    assert reverse_string("hello") == "olleh"
    assert reverse_string("abc") == "cba"
    assert reverse_string("") == ""


def test_to_upper():
    assert to_upper("hello") == "HELLO"
`,
    },
  },
  goal: "Fix the bug in src/strings.py so that pytest tests/ passes. The reverse_string() function currently returns the original string instead of reversing it. Use bash to install pytest and verify your fix.",
  acceptanceCommand: "python3 -m pytest tests/ -x -q",
  timeoutSeconds: 180,
  difficulty: "trivial" as const,
};

// ─── Docker availability check ────────────────────────────────────────────────

function checkDockerAvailable(): { ok: boolean; reason?: string } {
  try {
    execFileSync("docker", ["--version"], { stdio: "ignore", timeout: 5000 });
    return { ok: true };
  } catch {
    return { ok: false, reason: "docker binary not found or Docker is not running" };
  }
}

function pullDockerImage(image: string): { ok: boolean; reason?: string; durationMs: number } {
  const start = Date.now();
  try {
    console.log(`  Pulling image ${image}...`);
    execFileSync("docker", ["pull", image], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
    return { ok: true, durationMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      reason: `docker pull ${image} failed: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

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
        "    node examples/tbench-real-docker/dist/index.js",
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

  console.log("=== tbench-real-docker — Real-model + Docker Terminal-Bench run ===\n");
  console.log("Task: Fix the broken reverse_string() function in src/strings.py");
  console.log(`Acceptance: ${TASK_SPEC.acceptanceCommand}`);
  console.log(`Sandbox: HarborSandbox (Docker image: ${DOCKER_IMAGE})`);

  const effectiveModel = model ?? "gpt-4o";
  console.log(`Model: ${effectiveModel} (protocol: ${protocol})`);
  if (reasoning !== undefined) {
    console.log(`Reasoning effort: ${reasoning.effort}`);
  }
  if (baseURL !== undefined) {
    console.log(`Base URL: ${baseURL}`);
  }
  console.log();

  // 1. Check Docker
  console.log("Checking Docker availability...");
  const dockerCheck = checkDockerAvailable();
  if (!dockerCheck.ok) {
    console.log(`\nSKIPPED: ${dockerCheck.reason}`);
    process.exit(0);
  }
  console.log("  Docker is available.");

  // 2. Pull image
  console.log(`\nPulling Docker image: ${DOCKER_IMAGE}`);
  const pullResult = pullDockerImage(DOCKER_IMAGE);
  if (!pullResult.ok) {
    console.log(`\nSKIPPED: ${pullResult.reason}`);
    process.exit(0);
  }
  console.log(`  Image ready (${pullResult.durationMs}ms)`);

  // 3. Create provider
  const provider = new OpenAIProvider({
    apiKey,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(model !== undefined ? { model } : {}),
    protocol,
    ...(reasoning !== undefined ? { reasoning } : {}),
  });

  // 4. Materialize workspace
  console.log("\nMaterializing workspace...");
  const matResult = await materializeTask(TASK_SPEC);
  if (!matResult.ok) {
    console.error(`FATAL: Workspace materialization failed: ${matResult.error.message}`);
    process.exit(1);
  }

  const task = matResult.value;
  console.log(`  Workspace: ${task.workspaceRoot}`);

  // Verify bug present
  const stringsContent = await fs.readFile(
    path.join(task.workspaceRoot, "src/strings.py"),
    "utf-8",
  );
  const hasBug = stringsContent.includes("return s") && !stringsContent.includes("[::-1]");
  console.log(`  Bug present before run: ${hasBug ? "YES (expected)" : "NO (unexpected!)"}`);

  // 5. Wire blueprint: Harbor sandbox + real provider
  // acceptanceSandbox: "host" — python:3.12-slim does not ship with pytest and
  // --network=none prevents pip install inside the acceptance container.
  // The agent uses bash inside Docker; acceptance runs on the host.
  const { session, agentSpec } = makeTerminalBenchBlueprint({
    spec: TASK_SPEC,
    workspaceRoot: task.workspaceRoot,
    provider,
    sandboxMode: "harbor",
    harborImage: DOCKER_IMAGE,
    acceptanceSandbox: { kind: "host" },
    schemaAdapter: openaiSchemaAdapter,
    maxIterations: 20,
  });

  console.log(`\nSession: ${session.sessionId}`);
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
    console.log("Running perceive → decide → act → observe loop (bash calls go to Docker)...\n");

    // 6. Run agent loop — real model calls + Docker tool execution
    await session.kernel.runAgent(handle);

    const snapshot = await handle.snapshot();
    const wallMs = Date.now() - runStart;

    console.log("Agent loop complete:");
    console.log(`  State:      ${snapshot.state}`);
    console.log(`  Tokens in:  ${snapshot.usage.tokensIn}`);
    console.log(`  Tokens out: ${snapshot.usage.tokensOut}`);
    console.log(`  USD:        $${snapshot.usage.usd.toFixed(4)}`);
    console.log(`  Wall time:  ${wallMs}ms`);

    // 7. Run standalone acceptance on host
    console.log(`\nRunning acceptance command (host): ${TASK_SPEC.acceptanceCommand}`);
    const acceptance = await runAcceptance(
      TASK_SPEC.acceptanceCommand,
      task.workspaceRoot,
      TASK_SPEC.timeoutSeconds,
      { kind: "host" },
    );

    console.log("\n=== Acceptance Result ===");
    console.log("  Mode: Host (agent sandbox: Docker via HarborSandbox)");
    console.log(`  Exit code: ${acceptance.exitCode}`);
    console.log(`  Duration:  ${acceptance.durationMs}ms`);
    console.log(`  Verdict:   ${acceptance.verdict.kind}`);
    if (acceptance.stdout.trim()) {
      console.log(`  stdout:\n${acceptance.stdout}`);
    }
    if (acceptance.stderr.trim()) {
      console.log(`  stderr:\n${acceptance.stderr}`);
    }

    // 8. Check fix was applied
    const fixedContent = await fs.readFile(
      path.join(task.workspaceRoot, "src/strings.py"),
      "utf-8",
    );
    const bugFixed = fixedContent.includes("[::-1]") && !fixedContent.includes("return s\n");
    console.log(`\nBug fixed (file diff check): ${bugFixed ? "YES" : "NO"}`);
    if (!bugFixed) {
      console.log(`  File content:\n${fixedContent}`);
    }

    // 9. End session — kernel verdict gate
    await session.stopAdjudicatorWatch();
    const endResult = await session.kernel.endSession();

    if (!endResult.ok) {
      console.log(`\nSession end (verdict gate active): ${endResult.error.message}`);
    } else {
      const ledger = session.kernel.getCostMeter().ledger();
      console.log(`\nSession cost: $${ledger.totals.grand.toFixed(6)}`);
    }

    // 10. Final verdict — all three conditions must be true
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
        console.error("\nFile content check: src/strings.py still contains the bug.");
      }
      process.exit(1);
    }

    console.log("\nAll checks passed:");
    console.log("  - Bug fixed in src/strings.py (file content check)");
    console.log("  - Acceptance command exited 0 (pytest passed)");
    console.log("  - Kernel verdict gate: adjudicator confirmed aligned verdict");
    console.log("  - Agent's bash tool calls executed inside Docker container");
    console.log("\nReal-model + Docker Terminal-Bench run complete.");
  } finally {
    await task.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
