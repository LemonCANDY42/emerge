/**
 * dashboard-hello demo.
 *
 * Runs a minimal two-agent scenario (supervisor + worker) using MockProvider,
 * writes the session to a JSONL file, and prints the command to start the
 * dashboard server.
 *
 * Usage:
 *   node examples/dashboard-hello/dist/index.js
 *
 * Then in another terminal:
 *   node packages/dashboard/dist/server/cli.js --jsonl <path printed above>
 *   Open http://127.0.0.1:7777 in your browser.
 *
 * Skip-mode safe: no API keys required. Uses MockProvider only.
 * The demo exits 0 once the JSONL file has been written; it does not launch
 * the dashboard server (which is a long-running process).
 */

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdjudicator, buildCustodian, supervisorWorker } from "@emerge/agents";
import type { KernelLike } from "@emerge/agents";
import type {
  AgentId,
  ContractId,
  CorrelationId,
  EvaluationInput,
  ProviderEvent,
  QuotaDecision,
  QuotaRequest,
  SessionId,
  Verdict,
} from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { MockProvider } from "@emerge/provider-mock";
import { makeRecorder } from "@emerge/replay";

// ─── Scenario ─────────────────────────────────────────────────────────────────

const WORKER_TEXT =
  "The Punic Wars were three conflicts between Rome and Carthage (264–146 BC). Hannibal crossed the Alps.";
const SUPERVISOR_TEXT = `Summary: ${WORKER_TEXT}`;

function makeScript(text: string): readonly { events: readonly ProviderEvent[] }[] {
  return [
    {
      events: [
        { type: "text_delta", text },
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 20, tokensOut: text.length, wallMs: 30, toolCalls: 0, usd: 0.0001 },
        },
      ],
    },
  ];
}

async function main(): Promise<void> {
  // Write JSONL to a temp dir
  const tmpDir = mkdtempSync(join(tmpdir(), "emerge-dashboard-hello-"));
  const jsonlPath = join(tmpDir, "session.jsonl");

  const workerAId = "worker-a" as AgentId;
  const supervisorId = "supervisor-1" as AgentId;
  const custodianId = "custodian-1" as AgentId;
  const adjudicatorId = "adjudicator-1" as AgentId;
  const sessionId = `dash-hello-${Date.now()}` as SessionId;

  const contract = {
    id: "contract-dash-hello" as ContractId,
    goal: "Summarize a piece of text about the Punic Wars.",
    acceptanceCriteria: [{ kind: "predicate" as const, description: "Output contains key tokens" }],
    inputs: [
      {
        name: "text",
        schema: {
          "~standard": {
            version: 1 as const,
            vendor: "emerge",
            validate: (v: unknown) => ({ value: v }),
          },
        },
        description: "Input text",
      },
    ],
    outputs: [
      {
        name: "summary",
        schema: {
          "~standard": {
            version: 1 as const,
            vendor: "emerge",
            validate: (v: unknown) => ({ value: v }),
          },
        },
        description: "Summary",
      },
    ],
    constraints: [],
    hash: createHash("sha256").update("contract-dash-hello").digest("hex"),
  };

  // Providers
  const providerWorker = new MockProvider(makeScript(WORKER_TEXT), "mock-worker");
  const providerSup = new MockProvider(makeScript(SUPERVISOR_TEXT), "mock-supervisor");
  const providerRole = new MockProvider(
    [
      {
        events: [
          {
            type: "stop",
            reason: "end_turn",
            usage: { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
          },
        ],
      },
    ],
    "mock-role",
  );

  // Custodian
  const { spec: custodianSpec, instance: custodianInstance } = buildCustodian({
    id: custodianId,
    contract,
    quotaPolicy: (_req: QuotaRequest): QuotaDecision => ({
      kind: "deny",
      reason: "Demo: quota always denied",
    }),
    providerId: "mock-role",
    budgetCeiling: { tokensOut: 1000 },
  });

  // Adjudicator
  const KEY = ["punic", "hannibal"];
  const {
    spec: adjudicatorSpec,
    instance: adjudicatorInstance,
    watchBus,
  } = buildAdjudicator({
    id: adjudicatorId,
    contract,
    providerId: "mock-role",
    resultSenders: [workerAId, supervisorId],
    evaluate: (input: EvaluationInput): Verdict => {
      const text = JSON.stringify(input.outputs).toLowerCase();
      const missing = KEY.filter((k) => !text.includes(k));
      if (missing.length === 0) {
        return { kind: "aligned", rationale: "All key tokens present.", evidence: [] };
      }
      return {
        kind: "partial",
        missing: missing.map((m) => ({ kind: "predicate" as const, description: `Missing: ${m}` })),
        suggestion: `Include: ${missing.join(", ")}`,
      };
    },
  });

  // Kernel
  const recorder = makeRecorder({ filePath: jsonlPath });
  const kernel = new Kernel(
    {
      mode: "auto",
      reproducibility: "free",
      lineage: { maxDepth: 3 },
      bus: { bufferSize: 128 },
      roles: { custodian: custodianId, adjudicator: adjudicatorId },
      trustMode: "explicit",
    },
    { recorder },
  );

  kernel.mountProvider(providerWorker);
  kernel.mountProvider(providerSup);
  kernel.mountProvider(providerRole);
  kernel.mountCustodian(custodianInstance);
  kernel.setSession(sessionId, contract.id);

  const spawnCust = await kernel.spawn(custodianSpec);
  if (!spawnCust.ok) throw new Error(`custodian spawn failed: ${spawnCust.error}`);
  const spawnAdj = await kernel.spawn(adjudicatorSpec);
  if (!spawnAdj.ok) throw new Error(`adjudicator spawn failed: ${spawnAdj.error}`);

  const stopWatch = watchBus({ bus: kernel.getBus(), sessionId });

  // Worker spec
  const workerSpec = {
    id: workerAId,
    role: "worker",
    description: "Summarizes the Punic Wars text",
    provider: { kind: "static" as const, providerId: "mock-worker" },
    system: { kind: "literal" as const, text: `Summarize: ${WORKER_TEXT}` },
    toolsAllowed: [] as readonly string[],
    memoryView: { inheritFromSupervisor: false, writeTags: [] as string[] },
    budget: { tokensIn: 2000, tokensOut: 500 },
    termination: {
      maxIterations: 3,
      maxWallMs: 30_000,
      budget: { tokensIn: 2000, tokensOut: 500 },
      retry: { transient: 1, nonRetryable: 0 as const },
      cycle: { windowSize: 5, repeatThreshold: 3 },
      done: { kind: "predicate" as const, description: "end_turn" },
    },
    acl: {
      acceptsRequests: "any" as const,
      acceptsQueries: "any" as const,
      acceptsSignals: "any" as const,
      acceptsNotifications: "any" as const,
    },
    capabilities: {
      tools: [] as readonly string[],
      modalities: ["text"] as readonly ("text" | "image" | "audio" | "code")[],
      qualityTier: "standard" as const,
      streaming: true,
      interrupts: true,
      maxConcurrency: 1,
    },
    lineage: { depth: 1 },
  };

  const supervisorSpec = {
    id: supervisorId,
    role: "supervisor",
    description: "Aggregates worker output",
    provider: { kind: "static" as const, providerId: "mock-supervisor" },
    system: { kind: "literal" as const, text: "Aggregate the worker's summary." },
    toolsAllowed: [] as readonly string[],
    memoryView: { inheritFromSupervisor: false, writeTags: [] as string[] },
    budget: { tokensIn: 5000, tokensOut: 2000 },
    termination: {
      maxIterations: 3,
      maxWallMs: 30_000,
      budget: { tokensIn: 5000, tokensOut: 2000 },
      retry: { transient: 1, nonRetryable: 0 as const },
      cycle: { windowSize: 5, repeatThreshold: 3 },
      done: { kind: "predicate" as const, description: "end_turn" },
    },
    acl: {
      acceptsRequests: "any" as const,
      acceptsQueries: "any" as const,
      acceptsSignals: "any" as const,
      acceptsNotifications: "any" as const,
    },
    capabilities: {
      tools: [] as readonly string[],
      modalities: ["text"] as readonly ("text" | "image" | "audio" | "code")[],
      qualityTier: "standard" as const,
      streaming: true,
      interrupts: true,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
  };

  const topoResult = supervisorWorker({
    supervisor: supervisorSpec,
    workers: [workerSpec],
    dispatch: "parallel",
    custodianId,
    adjudicatorId,
    decomposer: (input) => [{ id: "task-1", payload: input }],
    acceptanceCriteria: "Output must contain references to the Punic Wars and Hannibal.",
  });

  if (!topoResult.ok) throw new Error(`topology build failed: ${topoResult.error}`);

  const kernelLike: KernelLike = kernel;
  const runResult = await topoResult.value.run(WORKER_TEXT, kernelLike, sessionId);
  if (!runResult.ok) throw new Error(`topology run failed: ${runResult.error}`);

  // Evaluate and emit verdict
  const evalResult = await adjudicatorInstance.evaluate({
    outputs: { summary: runResult.value },
    artifacts: [],
    rationale: "Dashboard-hello demo",
  });

  const verdictCorrId = `verdict-${Date.now()}` as CorrelationId;
  await kernel.getBus().send({
    kind: "verdict",
    correlationId: verdictCorrId,
    sessionId,
    from: adjudicatorId,
    to: { kind: "broadcast" },
    timestamp: Date.now(),
    verdict: evalResult,
  });
  await new Promise<void>((r) => setTimeout(r, 10));

  stopWatch();

  const endResult = await kernel.endSession();
  if (!endResult.ok) throw new Error(`endSession failed: ${endResult.error}`);

  // Print the path and instructions
  console.log("\n=== emerge dashboard-hello demo ===\n");
  console.log(`JSONL written to: ${jsonlPath}`);
  console.log("\nTo view in the dashboard, run:");
  console.log(`\n  node packages/dashboard/dist/server/cli.js --jsonl "${jsonlPath}"`);
  console.log("\nThen open: http://127.0.0.1:7777\n");
  console.log(
    "(Build the dashboard first with: pnpm build && pnpm --filter @emerge/dashboard build:client)\n",
  );

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
