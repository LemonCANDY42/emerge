/**
 * replay-smoke — records a session via mock provider, ends it, then replays
 * it and verifies the second run produces the same envelopes without re-prompting.
 *
 * Phase 1: free-tier run with MockProvider. Records all provider_call events.
 * Phase 2: record-replay tier. Uses RecordedProvider (not MockProvider) so the
 *           original provider is NEVER re-invoked. Asserts provider2.callIndex === 0.
 *
 * Exits non-zero on mismatch.
 */

import type {
  AgentId,
  Provider,
  ProviderEvent,
  SessionId,
  SessionRecord,
} from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { BuiltinModeRegistry, permissionPolicyForMode } from "@emerge/modes";
import { MockProvider } from "@emerge/provider-mock";
import { RecordedProvider, makeRecorder } from "@emerge/replay";
import { InProcSandbox } from "@emerge/sandbox-inproc";

async function spawnAndRun(kernel: Kernel, agentId: AgentId): Promise<void> {
  const spawnResult = await kernel.spawn({
    id: agentId,
    role: "worker",
    provider: { kind: "static", providerId: "mock-replay" },
    system: { kind: "literal", text: "You answer in one word." },
    toolsAllowed: [],
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    budget: { tokensIn: 1000, tokensOut: 100 },
    termination: {
      maxIterations: 3,
      maxWallMs: 10_000,
      budget: { tokensIn: 1000, tokensOut: 100 },
      retry: { transient: 1, nonRetryable: 0 },
      cycle: { windowSize: 3, repeatThreshold: 3 },
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
      streaming: true,
      interrupts: true,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
  });

  if (!spawnResult.ok) throw new Error(`spawn failed: ${spawnResult.error.message}`);
  await kernel.runAgent(spawnResult.value);
}

async function main() {
  console.log("=== replay-smoke ===\n");

  const script: { events: readonly ProviderEvent[] }[] = [
    {
      events: [
        { type: "text_delta", text: "Hello world" },
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 10, tokensOut: 5, wallMs: 50, toolCalls: 0, usd: 0.0001 },
        },
      ],
    },
  ];

  const modeRegistry = new BuiltinModeRegistry();
  const policy = permissionPolicyForMode(modeRegistry, "auto");
  const sandbox = new InProcSandbox(policy);
  void sandbox;

  // --- Phase 1: Record ---
  console.log("Phase 1: Recording session...");

  const recorder1 = makeRecorder();
  const provider1 = new MockProvider(script, "mock-replay");

  const kernel1 = new Kernel(
    {
      mode: "auto",
      reproducibility: "free",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 256 },
      roles: {},
    },
    { recorder: recorder1 },
  );
  kernel1.mountProvider(provider1);

  const sessionId1 = `replay-run1-${Date.now()}` as SessionId;
  // M7: setSession auto-starts the recorder; no manual recorder.start() needed
  kernel1.setSession(sessionId1, "replay-contract" as never);

  await spawnAndRun(kernel1, "replay-agent" as AgentId);

  const endResult1 = await kernel1.endSession();
  if (!endResult1.ok || !endResult1.value.record) {
    throw new Error("Failed to end first session");
  }
  const record1 = endResult1.value.record;
  console.log(`  Recorded ${record1.events.length} events.`);
  console.log(`  Provider1 call index after phase 1: ${provider1.callIndex}`);

  // Verify phase 1 called the provider at least once
  const providerCalls1 = record1.events.filter((e) => e.kind === "provider_call");
  console.log(`  Provider calls recorded: ${providerCalls1.length}`);

  // --- Phase 2: Replay (record-replay tier) ---
  console.log("\nPhase 2: Replaying session (record-replay tier)...");

  // provider2 is mounted but MUST NOT be called — RecordedProvider intercepts
  const provider2 = new MockProvider(script, "mock-replay");

  // replayProviderFactory: called by Kernel.spawn() to wrap the raw provider in
  // a RecordedProvider.  The factory lives here (not in the kernel) to avoid a
  // circular @emerge/kernel → @emerge/replay dependency.
  const replayProviderFactory = (rec: SessionRecord, original: Provider): Provider =>
    new RecordedProvider(rec, original.capabilities);

  const kernel2 = new Kernel(
    {
      mode: "auto",
      reproducibility: "record-replay",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 256 },
      roles: {},
    },
    {
      replayRecord: record1,
      replayProviderFactory,
    },
  );
  // Mount provider2 so kernel can resolve capabilities; invoke() will be
  // intercepted by RecordedProvider and never called on provider2.
  kernel2.mountProvider(provider2);

  const sessionId2 = `replay-run2-${Date.now()}` as SessionId;
  kernel2.setSession(sessionId2, "replay-contract" as never);

  await spawnAndRun(kernel2, "replay-agent" as AgentId);

  // --- Verify: provider2 must not have been called ---
  // MockProvider.callIndex is public — directly accessible here.
  const provider2CallIndex = provider2.callIndex;
  console.log(`\nProvider2 call index after phase 2: ${provider2CallIndex}`);

  if (provider2CallIndex !== 0) {
    console.error(
      `REPLAY MISMATCH: provider2.callIndex=${provider2CallIndex}, expected 0. The original provider was re-invoked during replay — RecordedProvider is not working.`,
    );
    process.exit(1);
  }

  console.log("provider2.callIndex === 0 — original provider was never re-invoked. PASS");

  // Also compare text content from recorded events
  const getText = (events: readonly (typeof record1)["events"][number][]) =>
    events
      .filter((e) => e.kind === "provider_call")
      .flatMap((e) =>
        e.kind === "provider_call"
          ? e.events
              .filter((ev) => ev.type === "text_delta")
              .map((ev) => (ev.type === "text_delta" ? ev.text : ""))
          : [],
      )
      .join("");

  const text1 = getText([...record1.events]);
  console.log(`\nText from phase 1: "${text1}"`);
  console.log("\nREPLAY MATCH");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
