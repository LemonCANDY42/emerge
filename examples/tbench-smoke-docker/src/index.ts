/**
 * tbench-smoke-docker — Task B self-test.
 *
 * Same shape as Task A but uses HarborSandbox (Docker) for shell execution.
 * The agent reads and fixes a 2-file Python repo using Docker containers.
 *
 * Acceptance test: `docker run --rm -v <workspace>:/workspace -w /workspace
 *   python:3.12-slim python3 -m pytest tests/ -x -q`
 *
 * Graceful skip: if docker is not available or image pull fails, exits 0
 * with a clear "SKIPPED" message.
 *
 * What this validates:
 *   - HarborSandbox container startup and workspace bind-mount
 *   - file writes from the agent persist to the host workspace
 *   - acceptance command runs correctly inside Docker
 *   - macOS Docker Desktop compatibility (workspace paths work)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  makeTerminalBenchBlueprint,
  materializeTask,
  runAcceptance,
} from "@emerge/eval-terminal-bench";
import type { ProviderEvent } from "@emerge/kernel/contracts";
import { MockProvider } from "@emerge/provider-mock";

// ─── Task spec ───────────────────────────────────────────────────────────────

const DOCKER_IMAGE = "python:3.12-slim";

const TASK_SPEC = {
  id: "smoke-docker-string-bug",
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
  goal: "Fix the bug in src/strings.py so that pytest tests/ passes. The reverse_string() function currently returns the original string instead of reversing it.",
  acceptanceCommand: "python3 -m pytest tests/ -x -q",
  timeoutSeconds: 120,
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
    console.log(`  Pulling image ${image} (may take a moment)...`);
    execFileSync("docker", ["pull", image], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000, // 5 minutes
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

// ─── Mock provider script ─────────────────────────────────────────────────────

function buildMockScript(workspaceRoot: string): readonly { events: readonly ProviderEvent[] }[] {
  const stringsPath = path.join(workspaceRoot, "src/strings.py");
  const fixedContent = `def reverse_string(s: str) -> str:
    return s[::-1]


def to_upper(s: str) -> str:
    return s.upper()
`;

  return [
    // Step 1: read the buggy file
    {
      events: [
        { type: "text_delta", text: "Let me read the source file to find the bug." },
        { type: "tool_call_start", toolCallId: "tc-1", name: "fs.read" },
        {
          type: "tool_call_input_delta",
          toolCallId: "tc-1",
          partial: JSON.stringify({ path: stringsPath }),
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
          text: "Found the bug: reverse_string just returns `s` instead of `s[::-1]`. Let me fix it.",
        },
        { type: "tool_call_start", toolCallId: "tc-2", name: "fs.write" },
        {
          type: "tool_call_input_delta",
          toolCallId: "tc-2",
          partial: JSON.stringify({ path: stringsPath, content: fixedContent }),
        },
        { type: "tool_call_end", toolCallId: "tc-2" },
        {
          type: "stop",
          reason: "tool_use",
          usage: { tokensIn: 200, tokensOut: 60, wallMs: 120, toolCalls: 1, usd: 0.002 },
        },
      ],
    },
    // Step 3: install pytest and run it (python:3.12-slim ships without pytest)
    {
      events: [
        {
          type: "text_delta",
          text: "Let me install pytest and verify the fix.",
        },
        { type: "tool_call_start", toolCallId: "tc-3", name: "bash" },
        {
          type: "tool_call_input_delta",
          toolCallId: "tc-3",
          partial: JSON.stringify({
            cmd: "pip install -q pytest && python3 -m pytest tests/ -x -q",
            cwd: workspaceRoot,
          }),
        },
        { type: "tool_call_end", toolCallId: "tc-3" },
        {
          type: "stop",
          reason: "tool_use",
          usage: { tokensIn: 350, tokensOut: 40, wallMs: 500, toolCalls: 1, usd: 0.003 },
        },
      ],
    },
    // Step 4: done
    {
      events: [
        {
          type: "text_delta",
          text: "Tests pass. The fix: changed `return s` to `return s[::-1]` in reverse_string(). Task complete.",
        },
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 450, tokensOut: 50, wallMs: 80, toolCalls: 0, usd: 0.004 },
        },
      ],
    },
  ];
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== tbench-smoke-docker — Task B self-test ===\n");
  console.log("Task: Fix the broken reverse_string() function in src/strings.py");
  console.log(`Acceptance: ${TASK_SPEC.acceptanceCommand}`);
  console.log(`Sandbox: HarborSandbox (Docker image: ${DOCKER_IMAGE})\n`);

  // 1. Check Docker
  console.log("Checking Docker availability...");
  const dockerCheck = checkDockerAvailable();
  if (!dockerCheck.ok) {
    console.log(`\nSKIPPED: ${dockerCheck.reason}`);
    console.log(
      "\nTo run Task B, install Docker Desktop from https://www.docker.com/products/docker-desktop/",
    );
    console.log("Then re-run this example.");
    process.exit(0); // Graceful skip
  }
  console.log("  Docker is available.");

  // 2. Pull image
  console.log(`\nPulling Docker image: ${DOCKER_IMAGE}`);
  const pullResult = pullDockerImage(DOCKER_IMAGE);
  if (!pullResult.ok) {
    console.log(`\nSKIPPED: ${pullResult.reason}`);
    console.log("Image pull failed — check network connectivity and Docker daemon status.");
    process.exit(0); // Graceful skip
  }
  console.log(`  Image ready (${pullResult.durationMs}ms)`);

  // 3. Materialize workspace
  console.log("\nMaterializing workspace...");
  const matResult = await materializeTask(TASK_SPEC);
  if (!matResult.ok) {
    console.error(`FATAL: Workspace materialization failed: ${matResult.error.message}`);
    process.exit(1);
  }

  const task = matResult.value;
  console.log(`  Workspace: ${task.workspaceRoot}`);

  // Verify bug exists
  const stringsContent = await fs.readFile(
    path.join(task.workspaceRoot, "src/strings.py"),
    "utf-8",
  );
  const hasBug = stringsContent.includes("return s") && !stringsContent.includes("[::-1]");
  console.log(`  Bug present before run: ${hasBug ? "YES (expected)" : "NO (unexpected!)"}`);

  // 4. Build provider + blueprint
  const script = buildMockScript(task.workspaceRoot);
  const provider = new MockProvider(script, "mock-docker-smoke");

  const { session, agentSpec } = makeTerminalBenchBlueprint({
    spec: TASK_SPEC,
    workspaceRoot: task.workspaceRoot,
    provider,
    sandboxMode: "harbor",
    harborImage: DOCKER_IMAGE,
    // Acceptance sandbox: use host mode because python:3.12-slim does not ship with
    // pytest and --network=none prevents pip install inside the acceptance container.
    // Production tbench runs should use a custom image with pytest pre-baked in.
    acceptanceSandbox: { kind: "host" },
  });

  console.log(`\nSession: ${session.sessionId}`);

  // 5. Run agent
  const startTime = Date.now();

  try {
    const spawnResult = await session.kernel.spawn(agentSpec);
    if (!spawnResult.ok) {
      console.error(`FATAL: Agent spawn failed: ${spawnResult.error.message}`);
      process.exit(1);
    }

    const handle = spawnResult.value;
    console.log(`Agent spawned: ${String(handle.id)}`);
    console.log("Running agent loop (bash tool calls go to Docker)...\n");

    await session.kernel.runAgent(handle);

    const snapshot = await handle.snapshot();
    const wallMs = Date.now() - startTime;

    console.log("Agent loop complete:");
    console.log(`  State: ${snapshot.state}`);
    console.log(`  Tokens in: ${snapshot.usage.tokensIn}`);
    console.log(`  Tokens out: ${snapshot.usage.tokensOut}`);
    console.log(`  Wall time: ${wallMs}ms`);

    // 6. Run acceptance tests on the host.
    // Note: Harbor (Docker) acceptance requires a pre-installed pytest image because
    // the acceptance container runs with --network=none (no pip install). For this
    // smoke test, we use host-mode acceptance since pytest is available on the host.
    // In production tbench runs, use a custom image with test dependencies pre-baked,
    // or allow network in the acceptance container for pip install.
    console.log(`\nRunning acceptance command (host): ${TASK_SPEC.acceptanceCommand}`);
    const acceptanceStart = Date.now();

    const acceptance = await runAcceptance(
      TASK_SPEC.acceptanceCommand,
      task.workspaceRoot,
      TASK_SPEC.timeoutSeconds,
      { kind: "host" },
    );
    const acceptanceDuration = Date.now() - acceptanceStart;

    console.log("\n=== Acceptance Result ===");
    console.log("  Mode: Host (agent sandbox: HarborSandbox with Docker)");
    console.log(`  Command: ${TASK_SPEC.acceptanceCommand}`);
    console.log(`  Exit code: ${acceptance.exitCode}`);
    console.log(`  Duration: ${acceptanceDuration}ms`);
    console.log(`  Verdict: ${acceptance.verdict.kind}`);
    if (acceptance.stdout.trim()) {
      console.log(`  stdout:\n${acceptance.stdout}`);
    }
    if (acceptance.stderr.trim()) {
      console.log(`  stderr:\n${acceptance.stderr}`);
    }

    // 7. Check fix was applied
    const fixedContent = await fs.readFile(
      path.join(task.workspaceRoot, "src/strings.py"),
      "utf-8",
    );
    const bugFixed = fixedContent.includes("[::-1]");
    console.log(`\nBug fixed: ${bugFixed ? "YES" : "NO"}`);

    // 8. End session
    session.stopAdjudicatorWatch();
    const endResult = await session.kernel.endSession();
    if (!endResult.ok) {
      console.log(`\nSession end (verdict gate): ${endResult.error.message}`);
    } else {
      const ledger = session.kernel.getCostMeter().ledger();
      console.log(`\nSession cost: $${ledger.totals.grand.toFixed(6)}`);
    }

    // Final — honest gate: BOTH the standalone acceptance AND the kernel verdict gate
    // (which runs the Adjudicator-mounted acceptance on the agent's terminal result envelope)
    // must agree. The kernel's verdict gate is the authoritative one for ADR 0035.
    const passed = acceptance.verdict.kind === "aligned" && bugFixed && endResult.ok;
    console.log(`\n=== FINAL RESULT: ${passed ? "PASS" : "FAIL"} ===`);

    if (!endResult.ok) {
      console.error("\nASSERTION: Kernel verdict gate refused to mark session completed.");
      console.error(
        "This indicates the Adjudicator-mounted acceptance run disagrees with the standalone one,",
      );
      console.error("or the Adjudicator never received an aligned verdict before endSession().");
      process.exit(1);
    }

    if (!passed) {
      console.error("\nASSERTION: Expected aligned verdict but acceptance failed.");
      console.error(
        "This means the mock provider did not correctly fix the bug, or Docker exec failed.",
      );
      process.exit(1);
    }

    if (!bugFixed) {
      console.error("\nASSERTION: Bug was not fixed in src/strings.py.");
      process.exit(1);
    }

    console.log("\nAll assertions passed. Task B Docker smoke test complete.");
  } finally {
    await task.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
