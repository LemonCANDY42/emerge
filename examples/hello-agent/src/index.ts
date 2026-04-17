/**
 * hello-agent — demo using the mock provider.
 *
 * Task: "Summarize this short README and write the summary to NOTES.md".
 * Uses: fs.read, fs.write, read_handle tools; auto mode; mock provider.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, CorrelationId, ProviderEvent, SessionId } from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { BuiltinModeRegistry, permissionPolicyForMode } from "@emerge/modes";
import { MockProvider } from "@emerge/provider-mock";
import { InMemorySessionRecorder } from "@emerge/replay";
import { InProcSandbox } from "@emerge/sandbox-inproc";
import { JsonlTelemetry } from "@emerge/telemetry-jsonl";
import { makeFsReadTool, makeFsWriteTool } from "@emerge/tools";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const modeRegistry = new BuiltinModeRegistry();
  const policy = permissionPolicyForMode(modeRegistry, "auto");
  const sandbox = new InProcSandbox(policy);

  // Script: read README → write NOTES.md → done
  const readmeContent = `emerge is a next-generation agent harness.
It is model-agnostic, multi-agent native, and self-aware.`;

  const script: { events: readonly ProviderEvent[] }[] = [
    {
      // First call: agent decides to read README
      events: [
        { type: "text_delta", text: "I'll read the README first." },
        {
          type: "tool_call_start",
          toolCallId: "tc-1",
          name: "fs.read",
        },
        {
          type: "tool_call_input_delta",
          toolCallId: "tc-1",
          partial: JSON.stringify({ path: path.join(__dirname, "../../README.md") }),
        },
        { type: "tool_call_end", toolCallId: "tc-1" },
        {
          type: "stop",
          reason: "tool_use",
          usage: { tokensIn: 50, tokensOut: 20, wallMs: 100, toolCalls: 1, usd: 0.001 },
        },
      ],
    },
    {
      // Second call: agent writes NOTES.md
      events: [
        { type: "text_delta", text: "Now I'll write the summary." },
        {
          type: "tool_call_start",
          toolCallId: "tc-2",
          name: "fs.write",
        },
        {
          type: "tool_call_input_delta",
          toolCallId: "tc-2",
          partial: JSON.stringify({
            path: path.join(__dirname, "../../NOTES.md"),
            content: `# Summary\n\n${readmeContent}\n\nKey features: model-agnostic, multi-agent, self-aware.\n`,
          }),
        },
        { type: "tool_call_end", toolCallId: "tc-2" },
        {
          type: "stop",
          reason: "tool_use",
          usage: { tokensIn: 200, tokensOut: 60, wallMs: 120, toolCalls: 1, usd: 0.002 },
        },
      ],
    },
    {
      // Third call: agent finishes
      events: [
        {
          type: "text_delta",
          text: "I have read the README and written a summary to NOTES.md. The task is complete.",
        },
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 300, tokensOut: 40, wallMs: 80, toolCalls: 0, usd: 0.003 },
        },
      ],
    },
  ];

  const provider = new MockProvider(script);
  const recorder = new InMemorySessionRecorder();
  const telemetry = new JsonlTelemetry("./.emerge/hello-agent-telemetry.jsonl");

  const kernel = new Kernel(
    {
      mode: "auto",
      reproducibility: "free",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 256 },
      roles: {},
    },
    {
      recorder,
      telemetry,
    },
  );

  kernel.mountProvider(provider);

  const sessionId = `hello-${Date.now()}` as SessionId;
  const contractId = "hello-contract" as never;
  kernel.setSession(sessionId, contractId);

  recorder.start(sessionId, contractId);

  // Register tools
  const registry = kernel.getToolRegistry();
  registry.register(makeFsReadTool(sandbox));
  registry.register(makeFsWriteTool(sandbox));

  const agentId = "hello-agent" as AgentId;
  const spawnResult = await kernel.spawn({
    id: agentId,
    role: "summarizer",
    description: "Summarizes README and writes NOTES.md",
    provider: { kind: "static", providerId: provider.capabilities.id },
    system: {
      kind: "literal",
      text: "You are a helpful assistant. Read the README.md file, summarize it, and write the summary to NOTES.md.",
    },
    toolsAllowed: ["fs.read", "fs.write"],
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    budget: { tokensIn: 10_000, tokensOut: 2000, usd: 1.0 },
    termination: {
      maxIterations: 10,
      maxWallMs: 60_000,
      budget: { tokensIn: 10_000, tokensOut: 2000 },
      retry: { transient: 3, nonRetryable: 0 },
      cycle: { windowSize: 5, repeatThreshold: 3 },
      done: { kind: "predicate", description: "Agent finishes with end_turn" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: ["fs.read", "fs.write"],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: true,
      interrupts: true,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
  });

  if (!spawnResult.ok) {
    console.error("Failed to spawn agent:", spawnResult.error);
    process.exit(1);
  }

  const handle = spawnResult.value;
  console.log(`\nAgent spawned: ${handle.id}`);
  console.log("Running perceive → decide → act → observe loop...\n");

  // Run the agent loop
  await kernel.runAgent(handle);

  // End session and get record
  const recordResult = await kernel.endSession();
  if (recordResult.ok && recordResult.value) {
    const record = recordResult.value;
    console.log(`\nSession complete: ${String(record.sessionId)}`);
    console.log(`  Events recorded: ${record.events.length}`);
    console.log(`  Started: ${new Date(record.startedAt).toISOString()}`);
  }

  const snapshot = await handle.snapshot();
  console.log(`\nAgent final state: ${snapshot.state}`);
  console.log(`  Tokens in: ${snapshot.usage.tokensIn}`);
  console.log(`  Tokens out: ${snapshot.usage.tokensOut}`);
  console.log(`  USD: $${snapshot.usage.usd.toFixed(4)}`);

  const cost = kernel.getCostMeter().ledger();
  console.log(`\nCost ledger: $${cost.totals.grand.toFixed(4)} total`);

  telemetry.close();

  console.log("\n--- Task complete ---");
  console.log("To use Anthropic instead of mock:");
  console.log("  1. Set ANTHROPIC_API_KEY=your-key");
  console.log("  2. Import AnthropicProvider from @emerge/provider-anthropic");
  console.log("  3. Replace MockProvider with new AnthropicProvider()");
  console.log("  4. Mount it via kernel.mountProvider(provider)");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
