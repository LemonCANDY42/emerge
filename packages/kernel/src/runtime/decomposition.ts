/**
 * Opaque adaptive decomposition.
 *
 * When surveillance recommends `decompose`, the kernel calls runDecomposition()
 * which:
 *   1. Generates N<=3 sub-step goals using a sentence-splitting heuristic
 *      (M2 strategy: no sub-agent for generation — avoids recursive spawning
 *      overhead and keeps the critical path cheap. A sub-agent decomposer is
 *      the M3+ path once topology helpers ship).
 *   2. Runs each sub-step sequentially via the existing provider (depth+1).
 *   3. Combines the results into a single synthetic ToolResult whose `preview`
 *      summarizes all sub-results.
 *   4. Returns the combined result — callers inject it into the inner agent's
 *      message history as if it were a normal tool result. The inner agent
 *      never sees sub-agent IDs, sub-prompts, or individual sub-results.
 *
 * Sub-step generation strategy: M2 uses a heuristic that splits the step goal
 * by sentence boundaries (period/semicolon) and caps at 3 sub-steps. If the
 * goal is a single sentence, it generates "research", "execute", "verify"
 * sub-phases. This avoids a full LLM call on the decomposition path, keeping
 * the critical path cheap. A prompt-based decomposer is the M3+ upgrade.
 */

import type {
  AgentSpec,
  LineageGuardConfig,
  Provider,
  ProviderMessage,
  ProviderRequest,
  ToolResult,
} from "../contracts/index.js";
import type { StepProfile } from "../contracts/surveillance.js";

export interface DecompositionInput {
  /** The step being decomposed. */
  readonly step: StepProfile;
  /** Current decomposition depth — sub-agents will run at depth+1. */
  readonly decompositionDepth: number;
  /** Lineage guard config to enforce maxDepth. */
  readonly lineageConfig: LineageGuardConfig;
  /** The provider to use for running sub-steps. */
  readonly provider: Provider;
  /** Messages accumulated so far in the parent agent's context. */
  readonly parentMessages: readonly ProviderMessage[];
  /** AbortSignal for cancellation. */
  readonly signal?: AbortSignal;
}

export interface DecompositionResult {
  /** The combined ToolResult to inject into the parent agent's working memory. */
  readonly combinedResult: ToolResult;
  /** How many sub-steps were executed. */
  readonly subStepCount: number;
  /** The sub-step goals that were generated (for kernel-level logging only). */
  readonly subStepGoals: readonly string[];
}

/**
 * Split a goal string into at most maxParts sub-goals using sentence boundaries.
 * Falls back to phase-based decomposition if the goal is a single sentence.
 */
function generateSubGoals(goal: string, maxParts = 3): readonly string[] {
  // Split on period or semicolon followed by space
  const sentences = goal
    .split(/[.;]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length >= 2) {
    return sentences.slice(0, maxParts);
  }

  // Single-sentence goal: decompose into research → execute → verify phases
  return [
    `Research and plan: ${goal}`,
    `Execute the plan for: ${goal}`,
    `Verify the result of: ${goal}`,
  ].slice(0, maxParts);
}

/**
 * Run a sub-step synchronously (a single provider call with the sub-goal as
 * the user turn). Returns the accumulated text from the provider response.
 */
async function runSubStep(
  subGoal: string,
  provider: Provider,
  parentMessages: readonly ProviderMessage[],
  signal?: AbortSignal,
): Promise<string> {
  // Build a minimal message context: system prompt (if any) + sub-goal as user turn
  const systemMessages = parentMessages.filter((m) => m.role === "system");
  const messages: ProviderMessage[] = [
    ...systemMessages,
    { role: "user", content: [{ type: "text", text: subGoal }] },
  ];

  const req: ProviderRequest = {
    messages,
    ...(signal !== undefined ? { signal } : {}),
  };

  let text = "";
  for await (const event of provider.invoke(req)) {
    if (signal?.aborted) break;
    if (event.type === "text_delta") {
      text += event.text;
    } else if (event.type === "stop" || event.type === "error") {
      break;
    }
  }
  return text || "(no output)";
}

/**
 * Run the opaque adaptive decomposition for a step that surveillance has
 * flagged as exceeding the model's envelope.
 *
 * Returns Result.error if decomposition depth would exceed lineage maxDepth.
 */
export async function runDecomposition(input: DecompositionInput): Promise<DecompositionResult> {
  const { step, decompositionDepth, lineageConfig, provider, parentMessages, signal } = input;

  // Guard: refuse if sub-agents would exceed maxDepth
  if (decompositionDepth + 1 > lineageConfig.maxDepth) {
    // Return a graceful fallback: a single "attempt" that proceeds with the
    // full goal, since we cannot decompose further.
    return {
      combinedResult: {
        ok: false,
        preview: `[decomposition refused: depth ${decompositionDepth + 1} would exceed maxDepth ${lineageConfig.maxDepth}]`,
      },
      subStepCount: 0,
      subStepGoals: [],
    };
  }

  const subGoals = generateSubGoals(step.goal, 3);
  const subResults: string[] = [];

  for (const subGoal of subGoals) {
    if (signal?.aborted) break;
    const result = await runSubStep(subGoal, provider, parentMessages, signal);
    subResults.push(result);
  }

  // Combine into a single preview — inner agent sees this as one opaque result
  const preview = subResults
    .map((r, i) => `[Part ${i + 1}/${subResults.length}]: ${r}`)
    .join("\n\n");

  return {
    combinedResult: {
      ok: true,
      preview: preview || "(decomposition produced no output)",
    },
    subStepCount: subResults.length,
    subStepGoals: subGoals,
  };
}

// Re-export for callers that need the type without the full AgentSpec
export type { StepProfile };
export type { AgentSpec };
