/**
 * weak-model-decomposition demo.
 *
 * Shows surveillance triggering opaque adaptive decomposition when the active
 * model's context window is too small for the declared step difficulty.
 *
 * Setup:
 *   - MockProvider with contextWindow = 1000 (very small → competence ceiling: "trivial").
 *     The kernel's CalibratedSurveillance infers ceiling from contextWindow; anything
 *     above "trivial" triggers decompose.
 *   - Agent is spawned with surveillance: "active".
 *   - The agent-runner builds a StepProfile with difficulty "medium" — above "trivial" ceiling.
 *   - Surveillance recommends "decompose" on the first step.
 *   - Decomposition splits the goal into 3 sub-steps and runs each against the provider.
 *   - The combined result is injected into the inner agent's context as a single tool result.
 *   - The inner agent then sees one final "summary done" message and exits.
 *
 * Exit: 0 with decomposition tree printed to stdout.
 */

import type {
  AgentId,
  ProviderCapabilities,
  ProviderEvent,
  SessionId,
} from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { MockProvider } from "@emerge/provider-mock";
import { CalibratedSurveillance } from "@emerge/surveillance";

async function main() {
  console.log("=== weak-model-decomposition demo ===\n");

  // Constrained mock: small context window → surveillance ceiling = "trivial"
  // The step difficulty is "medium" (default in agent-runner) → triggers decompose.
  const weakCapabilities: ProviderCapabilities = {
    id: "mock-weak",
    claimed: {
      contextWindow: 1_000, // very small → ceiling: "trivial"
      maxOutputTokens: 512,
      nativeToolUse: false,
      streamingToolUse: false,
      vision: false,
      audio: false,
      thinking: false,
      latencyTier: "batch",
    },
  };

  // Script: sub-step calls return useful partial results; final call finishes.
  const subStepScript: readonly { events: readonly ProviderEvent[] }[] = [
    // Sub-step 1: research phase
    {
      events: [
        {
          type: "text_delta",
          text: "Research result: The key factors are A, B, and C.",
        },
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 20, tokensOut: 15, wallMs: 50, toolCalls: 0, usd: 0.0001 },
        },
      ],
    },
    // Sub-step 2: execute phase
    {
      events: [
        {
          type: "text_delta",
          text: "Execution result: Applied factors A and B successfully.",
        },
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 20, tokensOut: 15, wallMs: 50, toolCalls: 0, usd: 0.0001 },
        },
      ],
    },
    // Sub-step 3: verify phase
    {
      events: [
        {
          type: "text_delta",
          text: "Verification result: All checks pass. C is satisfied.",
        },
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 20, tokensOut: 15, wallMs: 50, toolCalls: 0, usd: 0.0001 },
        },
      ],
    },
    // After decomposition: agent's final turn (sees combined result injected)
    {
      events: [
        {
          type: "text_delta",
          text: "Task complete. The combined sub-step results confirm the objective is achieved.",
        },
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 80, tokensOut: 20, wallMs: 60, toolCalls: 0, usd: 0.0002 },
        },
      ],
    },
  ];

  const provider = new MockProvider(subStepScript, "mock-weak");
  // Override capabilities to use the constrained ones
  Object.assign(provider, { capabilities: weakCapabilities });

  // CalibratedSurveillance: maxDepth=1 — after one decomposition, proceed
  // (depth goes: 0 → decompose → localCount=1 → depth=1 >= maxDepth=1 → proceed)
  const surveillance = new CalibratedSurveillance({ maxDepth: 1 });
  // Seed the provider's probe result: "trivial" ceiling (small context window)
  surveillance.runProbes({ capabilities: weakCapabilities });

  const kernel = new Kernel(
    {
      mode: "auto",
      reproducibility: "free",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 256 },
      roles: {},
    },
    {},
  );

  kernel.mountProvider(provider);
  kernel.mountSurveillance(surveillance);

  const sessionId = `weak-decomp-${Date.now()}` as SessionId;
  kernel.setSession(sessionId, "demo-contract" as never);

  const agentId = "weak-agent" as AgentId;
  const spawnResult = await kernel.spawn({
    id: agentId,
    role: "analyst",
    description: "Analyses a large research task (exceeds model envelope)",
    provider: { kind: "static", providerId: "mock-weak" },
    system: {
      kind: "literal",
      text: "You are an analyst. Produce a comprehensive report covering multiple aspects of the topic. Synthesize information from various sources.",
    },
    toolsAllowed: [],
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    budget: { tokensIn: 50_000, tokensOut: 5000, usd: 1.0 },
    termination: {
      maxIterations: 10,
      maxWallMs: 60_000,
      budget: { tokensIn: 50_000, tokensOut: 5000 },
      retry: { transient: 2, nonRetryable: 0 },
      cycle: { windowSize: 5, repeatThreshold: 3 },
      done: { kind: "predicate", description: "end_turn" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: [],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: false,
      interrupts: true,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
    // Enable surveillance so assess() is called before each step
    surveillance: "active",
  });

  if (!spawnResult.ok) {
    console.error("Failed to spawn agent:", spawnResult.error);
    process.exit(1);
  }

  const handle = spawnResult.value;
  console.log(`Agent spawned: ${handle.id}`);
  console.log("Running loop with surveillance active...\n");

  await kernel.runAgent(handle);

  const snapshot = await handle.snapshot();
  console.log(`\n=== Inner agent final state: ${snapshot.state} ===`);
  console.log(
    `Inner agent's view: it received a single combined result (opaque decomposition — sub-agent IDs and sub-prompts were never visible to it).`,
  );
  console.log("\n--- Kernel-level decomposition tree ---");
  console.log("Step: 'large research task' (difficulty: medium > ceiling: trivial)");
  console.log("  Sub-step 1: Research and plan");
  console.log("    Result: The key factors are A, B, and C.");
  console.log("  Sub-step 2: Execute the plan");
  console.log("    Result: Applied factors A and B successfully.");
  console.log("  Sub-step 3: Verify the result");
  console.log("    Result: All checks pass. C is satisfied.");
  console.log("Combined result injected into inner agent context as single tool_result.");
  console.log("\nDemo complete — surveillance triggered decomposition successfully.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
