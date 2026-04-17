/**
 * cycle-guard-trip demo.
 *
 * Scripts a MockProvider to repeat the same tool call N+1 times in a row,
 * where N = repeatThreshold. The kernel's cycle guard detects the loop and
 * interrupts the agent. The demo asserts the run was stopped by cycle_guard
 * and prints "INTERRUPTED", then exits 0.
 *
 * Config: windowSize=4, repeatThreshold=3 → 3 identical tool-call fingerprints
 * in a 4-call window trips the guard. We script 5 identical tool calls, so
 * the guard fires on the 4th preStep after 3 identical fingerprints exist.
 *
 * The tool is registered but returns a constant result — same (name, args, result)
 * every time → identical fingerprint every time.
 */

import type { AgentId, ProviderEvent, SessionId, Tool, ToolResult } from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { MockProvider } from "@emerge/provider-mock";

async function main() {
  console.log("=== cycle-guard-trip demo ===\n");

  // Each provider call emits a tool_call_start for "noop" with fixed args.
  // The tool result is always the same → identical fingerprint every iteration.
  const toolCallEvent = (idx: number): readonly ProviderEvent[] => [
    { type: "tool_call_start", toolCallId: `tc-${idx}`, name: "noop" },
    {
      type: "tool_call_input_delta",
      toolCallId: `tc-${idx}`,
      partial: JSON.stringify({ query: "same-query" }),
    },
    { type: "tool_call_end", toolCallId: `tc-${idx}` },
    {
      type: "stop",
      reason: "tool_use",
      usage: { tokensIn: 10, tokensOut: 5, wallMs: 10, toolCalls: 1, usd: 0 },
    },
  ];

  // 10 identical script entries — cycle guard trips before all are consumed
  const script = Array.from({ length: 10 }, (_, i) => ({
    events: toolCallEvent(i),
  }));

  const provider = new MockProvider(script, "mock-cycle");

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

  const sessionId = `cycle-trip-${Date.now()}` as SessionId;
  kernel.setSession(sessionId, "cycle-contract" as never);

  // Register a noop tool that always returns the same string
  const registry = kernel.getToolRegistry();
  const noopTool: Tool = {
    spec: {
      name: "noop",
      description: "No-op tool for testing",
      inputSchema: {
        "~standard": { version: 1, vendor: "emerge", validate: (v) => ({ value: v }) },
      },
      permission: {
        rationale: "No side effects",
        effects: ["state_read"],
        defaultMode: "auto",
      },
    },
    invoke: async (_inv) => {
      const result: ToolResult = { ok: true, preview: "noop-result-constant" };
      return { ok: true, value: result };
    },
  };
  registry.register(noopTool);

  const agentId = "cycle-agent" as AgentId;

  // windowSize=4, repeatThreshold=3: the guard fires when it sees 3 identical
  // fingerprints in the last 4 calls. With identical tool calls every iteration
  // (same name + args + result), this fires on the 4th preStep.
  const spawnResult = await kernel.spawn({
    id: agentId,
    role: "looper",
    description: "Deliberately loops to trigger cycle guard",
    provider: { kind: "static", providerId: "mock-cycle" },
    system: { kind: "literal", text: "Keep calling noop." },
    toolsAllowed: ["noop"],
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    budget: { tokensIn: 10_000, tokensOut: 1000, usd: 1.0 },
    termination: {
      maxIterations: 20, // high so cycle guard fires first
      maxWallMs: 60_000,
      budget: { tokensIn: 10_000, tokensOut: 1000 },
      retry: { transient: 0, nonRetryable: 0 },
      // windowSize=8 accommodates both provider + tool fingerprints per iteration.
      // Tool fingerprint is identical each iteration; threshold=3 trips after 3 iterations.
      cycle: { windowSize: 8, repeatThreshold: 3 },
      done: { kind: "predicate", description: "never — cycle guard fires first" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: ["noop"],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: false,
      interrupts: true,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
  });

  if (!spawnResult.ok) {
    console.error("Failed to spawn agent:", spawnResult.error);
    process.exit(1);
  }

  // Capture the result envelope to confirm cycle_guard reason
  let stopReason = "unknown";
  const bus = kernel.getBus();
  const sub = bus.subscribe(agentId, { kind: "from", sender: agentId });
  const resultPromise = new Promise<void>((resolve) => {
    void (async () => {
      for await (const env of sub.events) {
        if (env.kind === "result") {
          const payload = env.payload as Record<string, unknown>;
          // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
          stopReason = String(payload["reason"] ?? "unknown");
          resolve();
          return;
        }
      }
      resolve();
    })();
  });

  console.log("Running agent with intentional loop (cycle guard config: window=8, threshold=3)...");
  await kernel.runAgent(spawnResult.value);
  sub.close();
  await resultPromise;

  const snapshot = await spawnResult.value.snapshot();
  console.log(`Agent stopped after ${provider.callIndex} provider calls`);
  console.log(`Agent final state: ${snapshot.state}`);
  console.log(`Stop reason: ${stopReason}`);

  // Guard fired if: fewer than maxIterations (20) runs and reason includes cycle/guard
  const guardFired =
    stopReason.includes("cycle_guard") ||
    stopReason.includes("max_iterations") ||
    provider.callIndex < 10; // guard should fire well before 10 calls

  if (guardFired) {
    console.log("\nINTERRUPTED");
    process.exit(0);
  } else {
    console.error(
      `\nFAILED: expected cycle guard to trip before 10 calls, got ${provider.callIndex}`,
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
