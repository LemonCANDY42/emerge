/**
 * hello-agent — demo using the mock provider.
 *
 * Task: "Summarize this short README and write the summary to NOTES.md".
 * Uses: fs.read, fs.write tools; auto mode; mock provider.
 *
 * Reads examples/README.md (resolved relative to dist/ → ../../README.md).
 * Writes examples/NOTES.md.
 * Asserts NOTES.md exists and contains a non-error string after the run.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, ProviderEvent, SessionId } from "@emerge/kernel/contracts";
import { Kernel, anthropicAdapter } from "@emerge/kernel/runtime";
import { BuiltinModeRegistry, permissionPolicyForMode } from "@emerge/modes";
import { MockProvider } from "@emerge/provider-mock";
import { makeRecorder } from "@emerge/replay";
import { InProcSandbox } from "@emerge/sandbox-inproc";
import { JsonlTelemetry } from "@emerge/telemetry-jsonl";
import { makeFsReadTool, makeFsWriteTool } from "@emerge/tools";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path from dist/ → ../../README.md = examples/README.md (created at that path)
const readmePath = path.join(__dirname, "../../README.md");
// Write NOTES.md next to README.md in examples/
const notesPath = path.join(__dirname, "../../NOTES.md");

async function main() {
  const modeRegistry = new BuiltinModeRegistry();
  const policy = permissionPolicyForMode(modeRegistry, "auto");
  const sandbox = new InProcSandbox(policy);

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
          partial: JSON.stringify({ path: readmePath }),
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
            path: notesPath,
            content:
              "# Summary\n\nemerge is a TypeScript agent harness.\n\nKey features: model-agnostic, multi-agent, self-aware.\n",
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
  // makeRecorder auto-starts via setSession (M7); no manual recorder.start() needed
  const recorder = makeRecorder();
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

  // M6: mount the Anthropic schema adapter so tool specs are shaped correctly
  // when swapping in a real Anthropic provider. Logs activation for verification.
  kernel.mountSchemaAdapter(provider.capabilities.id, anthropicAdapter);
  console.log(`[hello-agent] schema adapter active for ${provider.capabilities.id}`);

  const sessionId = `hello-${Date.now()}` as SessionId;
  const contractId = "hello-contract" as never;
  // M7: setSession auto-starts the recorder; no separate recorder.start() call
  kernel.setSession(sessionId, contractId);

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

  // C3: print grand total from CostMeter (wired in agent-runner now)
  const cost = kernel.getCostMeter().ledger();
  console.log(`\nCost ledger: $${cost.totals.grand.toFixed(4)} total`);

  telemetry.close();

  // M6: assert NOTES.md exists and contains a non-error string
  let notesOk = false;
  try {
    const notesContent = await fs.readFile(notesPath, "utf-8");
    if (notesContent.length > 0 && !notesContent.toLowerCase().includes("error")) {
      notesOk = true;
      console.log(`\nNOTES.md written (${notesContent.length} bytes): OK`);
    } else {
      console.error(`\nNOTES.md content looks wrong: "${notesContent.slice(0, 100)}"`);
    }
  } catch (err) {
    console.error(`\nNOTES.md not found at ${notesPath}:`, err);
  }

  if (!notesOk) {
    console.error("ASSERTION FAILED: NOTES.md was not written correctly.");
    process.exit(1);
  }

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
