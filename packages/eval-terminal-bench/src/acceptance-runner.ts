/**
 * acceptance-runner — runs the task's acceptanceCommand in the workspace
 * and maps the exit code to a Verdict.
 *
 * Exit code 0 → verdict "aligned" (task passed acceptance tests).
 * Non-zero   → verdict "failed" (tests failed), with stdout/stderr in rationale.
 *
 * ## Trust model
 *
 * InProc mode (acceptanceSandbox: { kind: "host" }):
 *   The acceptance command runs on the host in the same workspace the agent
 *   wrote to. This is a fair-fight scenario: a malicious or buggy agent can
 *   drop files (e.g. conftest.py, pytest plugins) that affect the acceptance
 *   result. Use InProc mode ONLY with synthetic / known-good agents in
 *   controlled environments. The benefit: no Docker dependency, fast.
 *
 * Harbor mode (acceptanceSandbox: { kind: "harbor"; image: string }):
 *   The acceptance command runs in a FRESH ephemeral Docker container with
 *   the workspace bind-mounted READ-ONLY. The agent cannot install tooling
 *   overrides into a read-only mount. PATH is explicitly restricted to
 *   standard system paths so rogue binaries in the workspace are not found.
 *   This neutralises most agent-tamper vectors.
 *
 * Production benches MUST use Harbor mode. InProc mode is for fast CI smoke
 * tests with scripted mock agents only.
 */

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EvaluationInput, Verdict } from "@emerge/kernel/contracts";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface AcceptanceResult {
  readonly verdict: Verdict;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/**
 * Sandbox hint for the acceptance runner.
 *
 * - { kind: "host" } — run on the host (InProc mode). Fast; no tamper isolation.
 * - { kind: "harbor"; image: string } — run in a fresh read-only Docker container.
 *   Requires Docker. The workspace is mounted read-only so the agent cannot
 *   install tooling overrides. PATH is restricted to /usr/local/bin:/usr/bin:/bin.
 */
export type AcceptanceSandbox = { kind: "host" } | { kind: "harbor"; image: string };

/**
 * Run the acceptanceCommand in the given workspace directory and return
 * a structured AcceptanceResult.
 *
 * This function is used both as a standalone runner (for reporting) and
 * as the evaluate callback inside buildAdjudicator.
 */
export async function runAcceptance(
  acceptanceCommand: string,
  workspaceRoot: string,
  timeoutSeconds: number,
  acceptanceSandbox: AcceptanceSandbox = { kind: "host" },
): Promise<AcceptanceResult> {
  const start = Date.now();

  let exitCode: number;
  let stdout: string;
  let stderr: string;

  if (acceptanceSandbox.kind === "harbor") {
    // Run in a fresh ephemeral container with workspace mounted READ-ONLY.
    // This prevents the agent from installing rogue tooling that fakes acceptance.
    // PATH is restricted to prevent workspace binaries from being found.
    // --rm: clean up on exit (no container leak).
    const dockerArgv = [
      "run",
      "--rm",
      "--mount",
      `type=bind,source=${workspaceRoot},target=/workspace,readonly`,
      "--workdir",
      "/workspace",
      "--network=none",
      "--env",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      acceptanceSandbox.image,
      "sh",
      "-c",
      acceptanceCommand,
    ];

    try {
      const result = await execFileAsync("docker", dockerArgv, {
        timeout: timeoutSeconds * 1000,
        maxBuffer: 4 * 1024 * 1024,
      });
      exitCode = 0;
      stdout = result.stdout ?? "";
      stderr = result.stderr ?? "";
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number | string };
      exitCode = typeof e.code === "number" ? e.code : 1;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? String(err);
    }
  } else {
    // InProc (host) mode: run directly on the host. See trust model above.
    try {
      const result = await execAsync(acceptanceCommand, {
        cwd: workspaceRoot,
        timeout: timeoutSeconds * 1000,
        maxBuffer: 4 * 1024 * 1024, // 4 MB
      });
      exitCode = 0;
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number | string };
      exitCode = typeof e.code === "number" ? e.code : 1;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? String(err);
    }
  }

  const durationMs = Date.now() - start;

  const stdoutSummary = stdout.trim().slice(0, 500);
  const stderrSummary = stderr.trim().slice(0, 300);

  const verdict: Verdict =
    exitCode === 0
      ? {
          kind: "aligned",
          rationale: `Acceptance command exited with code 0: ${acceptanceCommand}`,
          evidence: [],
        }
      : {
          kind: "failed",
          reason: [
            `Acceptance command exited with code ${exitCode}: ${acceptanceCommand}`,
            stdoutSummary ? `stdout: ${stdoutSummary}` : "",
            stderrSummary ? `stderr: ${stderrSummary}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        };

  return { verdict, exitCode, stdout, stderr, durationMs };
}

/**
 * Build an evaluate callback suitable for buildAdjudicator that runs
 * the acceptance command when invoked.
 *
 * The returned function ignores the EvaluationInput (the agent's output)
 * and instead runs the command-based acceptance test — this is the
 * Terminal-Bench model: ground truth is the test suite, not an LLM judge.
 */
export function makeAcceptanceEvaluator(
  acceptanceCommand: string,
  workspaceRoot: string,
  timeoutSeconds: number,
  acceptanceSandbox: AcceptanceSandbox = { kind: "host" },
): (input: EvaluationInput) => Promise<Verdict> {
  return async (_input: EvaluationInput): Promise<Verdict> => {
    const result = await runAcceptance(
      acceptanceCommand,
      workspaceRoot,
      timeoutSeconds,
      acceptanceSandbox,
    );
    return result.verdict;
  };
}
