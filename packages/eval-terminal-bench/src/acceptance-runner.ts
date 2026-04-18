/**
 * acceptance-runner — runs the task's acceptanceCommand in the workspace
 * and maps the exit code to a Verdict.
 *
 * Exit code 0 → verdict "aligned" (task passed acceptance tests).
 * Non-zero   → verdict "failed" (tests failed), with stdout/stderr in rationale.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { EvaluationInput, Verdict } from "@emerge/kernel/contracts";

const execAsync = promisify(exec);

export interface AcceptanceResult {
  readonly verdict: Verdict;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

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
): Promise<AcceptanceResult> {
  const start = Date.now();

  let exitCode: number;
  let stdout: string;
  let stderr: string;

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
): (input: EvaluationInput) => Promise<Verdict> {
  return async (_input: EvaluationInput): Promise<Verdict> => {
    const result = await runAcceptance(acceptanceCommand, workspaceRoot, timeoutSeconds);
    return result.verdict;
  };
}
