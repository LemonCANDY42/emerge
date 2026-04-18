/**
 * TerminalBenchBlueprint — wires sensible defaults for running a
 * Terminal-Bench task end-to-end with an emerge session.
 *
 * Defaults:
 *   - trustMode: "explicit" (requires aligned verdict before endSession)
 *   - reproducibility: "record-replay" (session is replayable)
 *   - Adjudicator mounted and watching the bus
 *   - Tools: fs.read, fs.write, bash (all scoped to workspace)
 *   - Budget: 100k tokensIn / 8k tokensOut / 5 min wall time
 *   - maxIterations: 20 (enough for small bugfix tasks)
 */

import type { AgentSpec, Budget } from "@emerge/kernel/contracts";
import type { BuiltSession } from "./session-builder.js";
import { type SessionBuilderOptions, buildSession } from "./session-builder.js";

export interface TerminalBenchBlueprintOptions extends SessionBuilderOptions {
  /** Override maximum agent iterations. Default: 20. */
  readonly maxIterations?: number;
  /** Override token budget. Default: 100k in / 8k out. */
  readonly budget?: Partial<Budget>;
  /** System prompt override for the task agent. */
  readonly systemPrompt?: string;
}

export interface TerminalBenchBlueprint {
  readonly session: BuiltSession;
  /** Ready-to-use AgentSpec — pass to kernel.spawn(). */
  readonly agentSpec: AgentSpec;
}

/**
 * Create a TerminalBenchBlueprint. Builds the session and returns an
 * AgentSpec wired with sensible defaults for coding tasks.
 *
 * Usage:
 *   const bp = makeTerminalBenchBlueprint({ spec, workspaceRoot, provider });
 *   const handle = await bp.session.kernel.spawn(bp.agentSpec);
 *   if (!handle.ok) throw new Error(...);
 *   await bp.session.kernel.runAgent(handle.value);
 *   bp.session.stopAdjudicatorWatch();
 *   const result = await bp.session.kernel.endSession();
 */
export function makeTerminalBenchBlueprint(
  opts: TerminalBenchBlueprintOptions,
): TerminalBenchBlueprint {
  const session = buildSession(opts);

  const maxIterations = opts.maxIterations ?? 20;
  const budget: Budget = {
    tokensIn: opts.budget?.tokensIn ?? 100_000,
    tokensOut: opts.budget?.tokensOut ?? 8_000,
    wallMs: opts.budget?.wallMs ?? 5 * 60 * 1000,
    usd: opts.budget?.usd ?? 2.0,
  };

  const systemPrompt =
    opts.systemPrompt ??
    `You are a software engineer. Your goal is:

${opts.spec.goal}

You have access to these tools:
- fs.read: read file contents
- fs.write: write file contents
- bash: execute shell commands in the workspace

The workspace contains the repository files. Read the relevant files, understand the problem, implement the fix, and verify your solution using the bash tool before finishing.

When you are done, stop — do not keep iterating after the task is complete.`;

  const agentSpec: AgentSpec = {
    id: session.agentId,
    role: "coder",
    description: `Terminal-Bench task: ${opts.spec.title}`,
    provider: { kind: "static", providerId: opts.provider.capabilities.id },
    system: { kind: "literal", text: systemPrompt },
    toolsAllowed: ["fs.read", "fs.write", "bash"],
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    budget,
    termination: {
      maxIterations,
      maxWallMs: opts.spec.timeoutSeconds * 1000,
      budget,
      retry: { transient: 2, nonRetryable: 0 },
      cycle: { windowSize: 5, repeatThreshold: 3 },
      done: { kind: "predicate", description: "Agent stops with end_turn" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: ["fs.read", "fs.write", "bash"],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: true,
      interrupts: false,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
  };

  return { session, agentSpec };
}
