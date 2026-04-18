/**
 * hello-agent-openai — runs the hello-agent task against a real OpenAI model.
 *
 * Task: Read examples/README.md, summarize it, write the summary to NOTES.md.
 *
 * Environment variables:
 *   OPENAI_API_KEY    (required to run for real; if absent, prints skip message and exits 0)
 *   OPENAI_BASE_URL   (optional; defaults to api.openai.com)
 *   OPENAI_MODEL      (optional; defaults to gpt-4o)
 *   OPENAI_PROTOCOL   (optional; "chat" | "responses", defaults to "chat")
 *
 * Run:
 *   OPENAI_API_KEY=sk-... node examples/hello-agent-openai/dist/index.js
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, SessionId } from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { BuiltinModeRegistry, permissionPolicyForMode } from "@emerge/modes";
import { OpenAIProvider, openaiSchemaAdapter } from "@emerge/provider-openai";
import type { OpenAIProtocol } from "@emerge/provider-openai";
import { makeRecorder } from "@emerge/replay";
import { InProcSandbox } from "@emerge/sandbox-inproc";
import { makeFsReadTool, makeFsWriteTool } from "@emerge/tools";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readmePath = path.join(__dirname, "../../README.md");
const notesPath = path.join(__dirname, "../../NOTES.md");

async function main() {
  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const apiKey = process.env["OPENAI_API_KEY"];

  if (!apiKey) {
    console.log(
      "[skipped: OPENAI_API_KEY not set] — run with:\n  OPENAI_API_KEY=sk-... node examples/hello-agent-openai/dist/index.js\n  (model: gpt-4o by default; override with OPENAI_MODEL=<model>)",
    );
    process.exit(0);
  }

  console.log("=== hello-agent-openai ===\n");

  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const baseURL = process.env["OPENAI_BASE_URL"];
  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const model = process.env["OPENAI_MODEL"];
  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const protocolEnv = process.env["OPENAI_PROTOCOL"];
  const protocol: OpenAIProtocol = protocolEnv === "responses" ? "responses" : "chat";

  const provider = new OpenAIProvider({
    apiKey,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(model !== undefined ? { model } : {}),
    protocol,
  });

  console.log(`Provider: ${provider.capabilities.id} (protocol: ${protocol})`);

  const modeRegistry = new BuiltinModeRegistry();
  const policy = permissionPolicyForMode(modeRegistry, "auto");
  const sandbox = new InProcSandbox(policy);
  const recorder = makeRecorder();

  const kernel = new Kernel(
    {
      mode: "auto",
      reproducibility: "free",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 256 },
      roles: {},
      trustMode: "implicit",
    },
    { recorder },
  );

  kernel.mountProvider(provider);
  kernel.mountSchemaAdapter(provider.capabilities.id, openaiSchemaAdapter);

  const sessionId = `hello-openai-${Date.now()}` as SessionId;
  kernel.setSession(sessionId, "hello-contract" as never);

  const registry = kernel.getToolRegistry();
  registry.register(makeFsReadTool(sandbox));
  registry.register(makeFsWriteTool(sandbox));

  const agentId = "hello-agent-openai" as AgentId;
  const spawnResult = await kernel.spawn({
    id: agentId,
    role: "summarizer",
    description: "Reads README.md, summarizes it, writes NOTES.md",
    provider: { kind: "static", providerId: provider.capabilities.id },
    system: {
      kind: "literal",
      text: `You are a helpful assistant. Read the file at "${readmePath}", summarize it in 3-5 sentences, and write the summary to "${notesPath}". Use the fs.read and fs.write tools.`,
    },
    toolsAllowed: ["fs.read", "fs.write"],
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    budget: { tokensIn: 50_000, tokensOut: 4_000, usd: 2.0 },
    termination: {
      maxIterations: 10,
      maxWallMs: 120_000,
      budget: { tokensIn: 50_000, tokensOut: 4_000 },
      retry: { transient: 2, nonRetryable: 0 },
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
      qualityTier: "premium",
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
  console.log(`Agent spawned: ${handle.id}`);
  console.log("Running perceive → decide → act → observe loop...\n");

  await kernel.runAgent(handle);

  const recordResult = await kernel.endSession();
  const snapshot = await handle.snapshot();

  console.log(`\nAgent final state: ${snapshot.state}`);
  console.log(`  Tokens in:  ${snapshot.usage.tokensIn}`);
  console.log(`  Tokens out: ${snapshot.usage.tokensOut}`);
  console.log(`  USD:        $${snapshot.usage.usd.toFixed(4)}`);

  const cost = kernel.getCostMeter().ledger();
  console.log(`\nCost ledger: $${cost.totals.grand.toFixed(4)} total`);

  if (recordResult.ok && recordResult.value.record) {
    console.log(`\nSession complete: ${String(recordResult.value.record.sessionId)}`);
    console.log(`  Events: ${recordResult.value.record.events.length}`);
  }

  // Assert NOTES.md was written
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

  console.log("\n=== hello-agent-openai complete ===");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
