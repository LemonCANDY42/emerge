/**
 * hello-agent-custom-url — runs the hello-agent task against a self-hosted or
 * OpenAI-compatible LLM service (Ollama, vLLM, llama.cpp, LM Studio, OpenRouter,
 * or your own service).
 *
 * Task: Read examples/README.md, summarize it, write the summary to NOTES.md.
 *
 * Environment variables:
 *   EMERGE_LLM_BASE_URL  (required; e.g. "http://localhost:11434/v1" for Ollama)
 *   EMERGE_LLM_MODEL     (required; e.g. "llama3.2")
 *   EMERGE_LLM_API_KEY   (optional; many local services don't need one)
 *   EMERGE_LLM_PROTOCOL  (optional; "chat" | "responses", default "chat")
 *
 * Run against Ollama:
 *   EMERGE_LLM_BASE_URL=http://localhost:11434/v1 EMERGE_LLM_MODEL=llama3.2 \
 *     node examples/hello-agent-custom-url/dist/index.js
 *
 * Run against OpenRouter:
 *   EMERGE_LLM_BASE_URL=https://openrouter.ai/api/v1 \
 *   EMERGE_LLM_API_KEY=sk-or-... \
 *   EMERGE_LLM_MODEL=meta-llama/llama-3.3-70b-instruct \
 *     node examples/hello-agent-custom-url/dist/index.js
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, SessionId } from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { BuiltinModeRegistry, permissionPolicyForMode } from "@emerge/modes";
import { OpenAICompatProvider, openaiSchemaAdapter } from "@emerge/provider-openai-compat";
import type { OpenAIProtocol } from "@emerge/provider-openai-compat";
import { makeRecorder } from "@emerge/replay";
import { InProcSandbox } from "@emerge/sandbox-inproc";
import { makeFsReadTool, makeFsWriteTool } from "@emerge/tools";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readmePath = path.join(__dirname, "../../README.md");
const notesPath = path.join(__dirname, "../../NOTES.md");

async function main() {
  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const baseURL = process.env["EMERGE_LLM_BASE_URL"];
  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const model = process.env["EMERGE_LLM_MODEL"];

  if (!baseURL || !model) {
    console.log(
      "[skipped: EMERGE_LLM_BASE_URL and EMERGE_LLM_MODEL not set] — run with:\n" +
        "  EMERGE_LLM_BASE_URL=http://localhost:11434/v1 EMERGE_LLM_MODEL=llama3.2 \\\n" +
        "    node examples/hello-agent-custom-url/dist/index.js\n\n" +
        "Supported services: Ollama, vLLM, llama.cpp, LM Studio, OpenRouter, or any OpenAI-compatible endpoint.",
    );
    process.exit(0);
  }

  console.log("=== hello-agent-custom-url ===\n");

  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const apiKey = process.env["EMERGE_LLM_API_KEY"];
  // biome-ignore lint/complexity/useLiteralKeys: env access requires bracket notation
  const protocolEnv = process.env["EMERGE_LLM_PROTOCOL"];
  const protocol: OpenAIProtocol = protocolEnv === "responses" ? "responses" : "chat";

  const provider = new OpenAICompatProvider({
    name: "custom-llm",
    baseURL,
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    protocol,
  });

  console.log(`Provider: ${provider.capabilities.id}`);
  console.log(`  Base URL: ${baseURL}`);
  console.log(`  Model:    ${model}`);
  console.log(`  Protocol: ${protocol}`);

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

  const sessionId = `hello-custom-${Date.now()}` as SessionId;
  kernel.setSession(sessionId, "hello-contract" as never);

  const registry = kernel.getToolRegistry();
  registry.register(makeFsReadTool(sandbox));
  registry.register(makeFsWriteTool(sandbox));

  const agentId = "hello-agent-custom" as AgentId;
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
    budget: { tokensIn: 50_000, tokensOut: 4_000, usd: 5.0 },
    termination: {
      maxIterations: 10,
      maxWallMs: 180_000,
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

  await kernel.runAgent(handle);

  const recordResult = await kernel.endSession();
  const snapshot = await handle.snapshot();

  console.log(`\nAgent final state: ${snapshot.state}`);
  console.log(`  Tokens in:  ${snapshot.usage.tokensIn}`);
  console.log(`  Tokens out: ${snapshot.usage.tokensOut}`);
  console.log(`  USD:        $${snapshot.usage.usd.toFixed(4)}`);

  const cost = kernel.getCostMeter().ledger();
  console.log(`\nCost ledger: $${cost.totals.grand.toFixed(4)} total`);

  if (recordResult.ok && recordResult.value) {
    console.log(`\nSession complete: ${String(recordResult.value.sessionId)}`);
    console.log(`  Events: ${recordResult.value.events.length}`);
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

  console.log("\n=== hello-agent-custom-url complete ===");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
