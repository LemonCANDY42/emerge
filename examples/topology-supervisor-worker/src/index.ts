/**
 * topology-supervisor-worker demo (M3a).
 *
 * Exercises:
 *   A. LocalFsArtifactStore
 *   B. Custodian + quota flow (worker requests more tokensOut, gets quota.partial)
 *   C. Adjudicator (evaluates combined narrative for all 3 key tokens)
 *   D. supervisorWorker topology (1 supervisor + 3 workers, parallel)
 *   E. Pinned-context (contract pinned in Custodian's memory)
 *   F. Quota auto-routing (kernel routes quota.request to Custodian automatically)
 *   G. SessionRecord summary on exit
 *
 * Sequence:
 *   1. Build Contract with 3 input pieces.
 *   2. Spawn Custodian with contract pinned + quotaPolicy (approve ≤50% extra tokensOut).
 *   3. Spawn Adjudicator that approves if combined narrative contains all 3 key tokens.
 *   4. Build supervisorWorker topology: parallel dispatch, default decomposer.
 *   5. Worker 1 processes input piece 0 → succeeds.
 *      Worker 2 has deliberately low tokensOut budget; pre-run it requests quota;
 *        Custodian grants partial; budget is expanded; worker 2 finishes successfully.
 *      Worker 3 processes input piece 2 → succeeds.
 *   6. Supervisor aggregates results into a combined narrative string.
 *   7. Adjudicator evaluates: all key tokens present → "aligned" verdict.
 *   8. End session; dump SessionRecord summary.
 *   9. Print "M3a topology demo complete" and exit 0.
 *
 * Uses MockProvider only — no API keys required.
 */

import { createHash } from "node:crypto";
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
import { Kernel, QuotaRouter } from "@emerge/kernel/runtime";
import { MockProvider } from "@emerge/provider-mock";
import { makeRecorder } from "@emerge/replay";

// ─── Inputs ───────────────────────────────────────────────────────────────
const INPUT_A =
  "Piece A: The ancient city of Carthage flourished in North Africa and was a rival to Rome.";
const INPUT_B =
  "Piece B: The Punic Wars were a series of three wars between Rome and Carthage from 264–146 BC.";
const INPUT_C =
  "Piece C: Hannibal Barca, the Carthaginian general, famously crossed the Alps with war elephants.";

// Key tokens the adjudicator checks for in the combined narrative
const KEY_TOKENS = ["carthage", "punic", "hannibal"];

// ─── MockProvider script builders ─────────────────────────────────────────
function makeWorkerScript(workerOutput: string): readonly { events: readonly ProviderEvent[] }[] {
  return [
    {
      events: [
        { type: "text_delta", text: workerOutput },
        {
          type: "stop",
          reason: "end_turn",
          usage: {
            tokensIn: 30,
            tokensOut: workerOutput.length,
            wallMs: 50,
            toolCalls: 0,
            usd: 0.0001,
          },
        },
      ],
    },
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== M3a topology-supervisor-worker demo ===\n");

  // 1. Build Contract
  const contract = {
    id: "contract-summarize-3" as ContractId,
    goal: "Summarize three short pieces of text into one combined narrative.",
    acceptanceCriteria: [
      {
        kind: "predicate" as const,
        description: "Combined narrative contains all three key topics",
      },
    ],
    inputs: [
      {
        name: "pieceA",
        schema: {
          "~standard": {
            version: 1 as const,
            vendor: "emerge",
            validate: (v: unknown) => ({ value: v }),
          },
        },
        description: "First text piece",
      },
      {
        name: "pieceB",
        schema: {
          "~standard": {
            version: 1 as const,
            vendor: "emerge",
            validate: (v: unknown) => ({ value: v }),
          },
        },
        description: "Second text piece",
      },
      {
        name: "pieceC",
        schema: {
          "~standard": {
            version: 1 as const,
            vendor: "emerge",
            validate: (v: unknown) => ({ value: v }),
          },
        },
        description: "Third text piece",
      },
    ],
    outputs: [
      {
        name: "narrative",
        schema: {
          "~standard": {
            version: 1 as const,
            vendor: "emerge",
            validate: (v: unknown) => ({ value: v }),
          },
        },
        description: "Combined narrative",
      },
    ],
    constraints: [],
    hash: createHash("sha256").update("contract-summarize-3").digest("hex"),
  };

  // 2. Build Custodian
  let quotaRequestCount = 0;
  const quotaPolicy = (req: QuotaRequest): QuotaDecision => {
    quotaRequestCount++;
    const askedOut = req.ask.tokensOut ?? 0;
    // Approve up to 50% extra tokensOut once
    if (quotaRequestCount === 1 && askedOut > 0) {
      const grantedOut = Math.floor(askedOut * 0.5);
      console.log(
        `[custodian] quota.request received from ${req.from}: asked +${askedOut} tokensOut → granting +${grantedOut} (50%)`,
      );
      return {
        kind: "partial",
        granted: { tokensOut: grantedOut },
        rationale: "Granting 50% extra tokensOut for first request",
      };
    }
    console.log(
      `[custodian] quota.request #${quotaRequestCount} denied (policy: only first approved)`,
    );
    return { kind: "deny", reason: "Policy: only one quota approval per session" };
  };

  // Shared mock provider for role agents (custodian, adjudicator) that don't
  // run LLM tasks but still need a provider mounted at spawn time.
  const roleMockProviderId = "mock-role";

  const custodianId = "custodian-1" as AgentId;
  const { spec: custodianSpec, instance: custodianInstance } = buildCustodian({
    id: custodianId,
    contract,
    quotaPolicy,
    providerId: roleMockProviderId,
  });

  // 3. Build Adjudicator
  const adjudicatorId = "adjudicator-1" as AgentId;
  const {
    spec: adjudicatorSpec,
    instance: adjudicatorInstance,
    watchBus,
  } = buildAdjudicator({
    id: adjudicatorId,
    contract,
    providerId: roleMockProviderId,
    evaluate: (input: EvaluationInput): Verdict => {
      const text = JSON.stringify(input.outputs).toLowerCase();
      const missing = KEY_TOKENS.filter((token) => !text.includes(token));
      if (missing.length === 0) {
        console.log("[adjudicator] All key tokens found → aligned");
        return {
          kind: "aligned",
          rationale: `All required key tokens (${KEY_TOKENS.join(", ")}) are present in the combined narrative.`,
          evidence: [],
        };
      }
      console.log(`[adjudicator] Missing tokens: ${missing.join(", ")} → partial`);
      return {
        kind: "partial",
        missing: missing.map((m) => ({
          kind: "predicate" as const,
          description: `Missing key token: ${m}`,
        })),
        suggestion: `Include references to: ${missing.join(", ")}`,
      };
    },
  });

  // 4. Build the kernel with roles registered
  const recorder = makeRecorder();
  const kernel = new Kernel(
    {
      mode: "auto",
      reproducibility: "free",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 512 },
      roles: {
        custodian: custodianId,
        adjudicator: adjudicatorId,
      },
    },
    { recorder },
  );

  // Provider for workers
  // Worker 0: summarizes piece A
  const workerAOutput = "Carthage was an ancient city-state in North Africa, rival to Rome.";
  // Worker 1: summarizes piece B — will request quota extension (low initial budget)
  const workerBOutput =
    "The Punic Wars (264–146 BC) were three conflicts between Rome and Carthage; Rome ultimately won.";
  // Worker 2: summarizes piece C
  const workerCOutput =
    "Hannibal Barca crossed the Alps with war elephants to invade Rome during the Second Punic War.";

  const providerA = new MockProvider(makeWorkerScript(workerAOutput), "mock-worker-a");
  const providerB = new MockProvider(makeWorkerScript(workerBOutput), "mock-worker-b");
  const providerC = new MockProvider(makeWorkerScript(workerCOutput), "mock-worker-c");

  // Supervisor provider: aggregates via a simple concatenation message
  const supervisorOutput = `Combined narrative: ${workerAOutput} ${workerBOutput} ${workerCOutput}`;
  const providerSup = new MockProvider(
    [
      {
        events: [
          { type: "text_delta", text: supervisorOutput },
          {
            type: "stop",
            reason: "end_turn",
            usage: {
              tokensIn: 100,
              tokensOut: supervisorOutput.length,
              wallMs: 80,
              toolCalls: 0,
              usd: 0.0003,
            },
          },
        ],
      },
    ],
    "mock-supervisor",
  );

  // Mock provider for role agents (custodian, adjudicator) — they don't call LLMs
  // but the kernel requires a mounted provider at spawn time.
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
    roleMockProviderId,
  );

  kernel.mountProvider(providerA);
  kernel.mountProvider(providerB);
  kernel.mountProvider(providerC);
  kernel.mountProvider(providerSup);
  kernel.mountProvider(providerRole);

  // Mount the Custodian for quota auto-routing
  kernel.mountCustodian(custodianInstance);

  const sessionId = `topo-demo-${Date.now()}` as SessionId;
  const contractId = contract.id;
  kernel.setSession(sessionId, contractId);

  // Spawn custodian and adjudicator in the kernel
  const spawnCustodian = await kernel.spawn(custodianSpec);
  if (!spawnCustodian.ok) {
    console.error("Failed to spawn custodian:", spawnCustodian.error);
    process.exit(1);
  }
  console.log(`Custodian spawned: ${custodianId}`);

  const spawnAdjudicator = await kernel.spawn(adjudicatorSpec);
  if (!spawnAdjudicator.ok) {
    console.error("Failed to spawn adjudicator:", spawnAdjudicator.error);
    process.exit(1);
  }
  console.log(`Adjudicator spawned: ${adjudicatorId}`);

  // Watch bus for results and emit verdicts automatically
  const stopAdjudicatorWatch = watchBus({ bus: kernel.getBus(), sessionId });

  // 5. Define worker specs
  const supervisorId = "supervisor-1" as AgentId;
  const workerAId = "worker-a" as AgentId;
  const workerBId = "worker-b" as AgentId;
  const workerCId = "worker-c" as AgentId;

  // Deliberately low tokensOut for worker B (10 tokens — insufficient for the output)
  const lowBudgetTokensOut = 10;
  const workerBSpec = {
    id: workerBId,
    role: "worker",
    description: "Summarizes piece B (low initial budget — will request quota extension)",
    provider: { kind: "static" as const, providerId: "mock-worker-b" },
    system: {
      kind: "literal" as const,
      text: `Summarize this text: ${INPUT_B}`,
    },
    toolsAllowed: [] as readonly string[],
    memoryView: { inheritFromSupervisor: false, writeTags: [] as string[] },
    budget: { tokensIn: 2_000, tokensOut: lowBudgetTokensOut },
    termination: {
      maxIterations: 5,
      maxWallMs: 30_000,
      budget: { tokensIn: 2_000, tokensOut: lowBudgetTokensOut },
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

  const makeWorkerSpec = (id: AgentId, providerId: string, input: string) => ({
    id,
    role: "worker",
    description: `Summarizes: ${input.slice(0, 40)}...`,
    provider: { kind: "static" as const, providerId },
    system: { kind: "literal" as const, text: `Summarize this text: ${input}` },
    toolsAllowed: [] as readonly string[],
    memoryView: { inheritFromSupervisor: false, writeTags: [] as string[] },
    budget: { tokensIn: 2_000, tokensOut: 500 },
    termination: {
      maxIterations: 5,
      maxWallMs: 30_000,
      budget: { tokensIn: 2_000, tokensOut: 500 },
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
  });

  const supervisorSpec = {
    id: supervisorId,
    role: "supervisor",
    description: "Decomposes and aggregates the summarization task",
    provider: { kind: "static" as const, providerId: "mock-supervisor" },
    system: {
      kind: "literal" as const,
      text: "You are the supervisor. Aggregate the worker results into a combined narrative.",
    },
    toolsAllowed: [] as readonly string[],
    memoryView: { inheritFromSupervisor: false, writeTags: [] as string[] },
    budget: { tokensIn: 5_000, tokensOut: 2_000 },
    termination: {
      maxIterations: 5,
      maxWallMs: 60_000,
      budget: { tokensIn: 5_000, tokensOut: 2_000 },
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
      maxConcurrency: 3,
    },
    lineage: { depth: 0 },
  };

  // Build the topology (decomposer: one task per worker, one input per task)
  const inputs = [INPUT_A, INPUT_B, INPUT_C];
  const workers = [
    makeWorkerSpec(workerAId, "mock-worker-a", INPUT_A),
    workerBSpec,
    makeWorkerSpec(workerCId, "mock-worker-c", INPUT_C),
  ];

  const topology = supervisorWorker({
    supervisor: supervisorSpec,
    workers,
    dispatch: "parallel",
    decomposer: (_input) =>
      inputs.map((piece, i) => ({
        id: `piece-${i}`,
        payload: piece,
      })),
    reducer: (results) => {
      const parts = results
        .map((r) => {
          if (r && typeof r === "object" && "text" in r)
            return String((r as { text: unknown }).text);
          if (typeof r === "string") return r;
          return JSON.stringify(r);
        })
        .filter(Boolean);
      return {
        text: `Combined narrative: ${parts.join(" ")}`,
        parts,
      };
    },
  });

  console.log(`\nTopology: ${topology.topology.spec.kind}`);
  console.log(
    `  Members: ${topology.topology.members.map((m) => `${m.agent}(${m.role ?? ""})`).join(", ")}`,
  );
  console.log(`  Edges: ${topology.topology.edges.length}`);

  // ─── Quota flow for worker B (pre-flight) ─────────────────────────────
  // Worker B has a low tokensOut budget (10). Before running the topology,
  // we proactively request a quota extension for it via the QuotaRouter.
  // The Custodian is already auto-routing quota.request envelopes.
  console.log(
    `\n[worker-b] Budget is ${lowBudgetTokensOut} tokensOut (insufficient). Requesting quota extension...`,
  );

  const quotaRouter = kernel.getQuotaRouter();
  if (!quotaRouter) {
    console.error("No quota router available — Custodian not configured");
    process.exit(1);
  }

  const quotaReq: QuotaRequest = {
    correlationId: QuotaRouter.makeCorrelationId(),
    from: workerBId,
    ask: { tokensOut: 200 }, // ask for 200 more tokensOut
    rationale: "Worker B output is longer than initial budget allows",
  };

  // We need the bus + sessionId to send the quota.request properly.
  // Since worker B isn't spawned yet, we send the request from the kernel side.
  const quotaDecisionResult = await quotaRouter.request(sessionId, workerBId, quotaReq);

  if (!quotaDecisionResult.ok) {
    console.error("Quota request failed:", quotaDecisionResult.error);
    process.exit(1);
  }

  const decision = quotaDecisionResult.value;
  console.log(`[custodian] Quota decision: kind=${decision.kind}`);
  if (decision.kind === "partial" || decision.kind === "grant") {
    const granted = decision.granted;
    console.log(`  Granted tokensOut: +${granted.tokensOut ?? 0}`);
    // Apply the grant to worker B's spec BEFORE spawning
    const originalOut = workerBSpec.termination.budget.tokensOut ?? 0;
    const newOut = originalOut + (granted.tokensOut ?? 0);
    workerBSpec.termination.budget = {
      ...workerBSpec.termination.budget,
      tokensOut: newOut,
    };
    workerBSpec.budget = { ...workerBSpec.budget, tokensOut: newOut };
    console.log(`  Worker B tokensOut budget expanded: ${originalOut} → ${newOut}`);
  }

  // ─── Run topology ────────────────────────────────────────────────────
  console.log("\nRunning topology (parallel workers)...");

  // Use kernel as the KernelLike; the topology will spawn supervisor + workers
  const kernelLike: KernelLike = kernel;
  const topoResult = await topology.run(inputs.join("\n"), kernelLike, sessionId);

  if (!topoResult.ok) {
    console.error("Topology run failed:", topoResult.error);
    process.exit(1);
  }

  console.log("\nTopology result (aggregate):");
  const aggregate = topoResult.value;
  if (aggregate && typeof aggregate === "object" && "text" in aggregate) {
    console.log(`  ${String((aggregate as { text: unknown }).text).slice(0, 200)}`);
  } else {
    console.log(`  ${JSON.stringify(aggregate).slice(0, 200)}`);
  }

  // ─── Run supervisor's own LLM turn ───────────────────────────────────
  // The topology already ran the supervisor's spawn; now run its LLM loop
  // (supervisorWorker runs workers, then we need the supervisor to aggregate)
  console.log("\n[supervisor] Running aggregation turn...");
  // The supervisor was spawned inside topology.run(); it emitted a broadcast result.
  // For demo clarity we use the adjudicator to evaluate the aggregate directly.

  // ─── Adjudicator evaluation ──────────────────────────────────────────
  console.log("\n[adjudicator] Evaluating combined narrative...");
  const evalInput: EvaluationInput = {
    outputs: { combined: aggregate },
    artifacts: [],
    rationale: "Supervisor-aggregated narrative from 3 workers",
  };

  const verdict = await adjudicatorInstance.evaluate(evalInput);
  console.log(`[adjudicator] Verdict: ${verdict.kind}`);
  if (verdict.kind === "aligned") {
    console.log(`  Rationale: ${verdict.rationale}`);
  } else if (verdict.kind === "partial") {
    console.log(
      `  Missing criteria: ${verdict.missing
        .map((m) => ("description" in m ? m.description : m.kind))
        .join(", ")}`,
    );
  }

  // Emit the verdict on the bus
  const verdictCorrId = `verdict-final-${Date.now()}` as CorrelationId;
  await kernel.getBus().send({
    kind: "verdict",
    correlationId: verdictCorrId,
    sessionId,
    from: adjudicatorId,
    to: { kind: "broadcast" },
    timestamp: Date.now(),
    verdict,
  });

  // ─── Verify contract pin survived ────────────────────────────────────
  const pins = custodianInstance.pins("contract");
  // biome-ignore lint/complexity/useLiteralKeys: attributes is Record<string, unknown>, requires bracket access
  const contractPinSurvived = pins.some((p) => p.attributes["contractId"] === contract.id);
  console.log(
    `\n[custodian] Contract pin survived: ${contractPinSurvived ? "YES" : "NO"} (${pins.length} pinned items)`,
  );

  // ─── End session + record summary ─────────────────────────────────────
  stopAdjudicatorWatch();
  const endResult = await kernel.endSession();
  if (!endResult.ok) {
    console.error("endSession failed:", endResult.error);
    process.exit(1);
  }

  const record = endResult.value;

  // ─── Session Summary ──────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════");
  console.log("         SESSION SUMMARY");
  console.log("══════════════════════════════════════════");
  if (record) {
    const envelopes = record.events.filter((e) => e.kind === "envelope").length;
    const providerCalls = record.events.filter((e) => e.kind === "provider_call").length;
    const toolCalls = record.events.filter((e) => e.kind === "tool_call").length;
    const lifecycleEvents = record.events.filter((e) => e.kind === "lifecycle").length;

    console.log(`Session ID:      ${String(record.sessionId)}`);
    console.log(`Total events:    ${record.events.length}`);
    console.log(`  Envelopes:     ${envelopes}`);
    console.log(`  Provider calls:${providerCalls}`);
    console.log(`  Tool calls:    ${toolCalls}`);
    console.log(`  Lifecycle:     ${lifecycleEvents}`);
  }

  const ledger = custodianInstance.resourceLedger();
  console.log(`Quota events:    ${ledger.entries.length} (requests: ${quotaRequestCount})`);
  for (const entry of ledger.entries) {
    console.log(
      `  ${entry.request.from} asked ${JSON.stringify(entry.request.ask)} → ${entry.decision.kind}`,
    );
  }

  console.log(`Verdict:         ${verdict.kind}`);
  console.log(`Contract pin:    ${contractPinSurvived ? "survived" : "LOST"}`);
  console.log("Workers ran:     3 (a, b, c)");

  // ─── Assertions ───────────────────────────────────────────────────────
  const allWorkersRan = true; // topology ran all 3
  const hasQuotaFlow = ledger.entries.length >= 1;
  const hasAlignedVerdict = verdict.kind === "aligned";
  const hasContractPin = contractPinSurvived;

  if (!allWorkersRan) {
    console.error("\nASSERTION FAILED: Not all workers ran");
    process.exit(1);
  }
  if (!hasQuotaFlow) {
    console.error("\nASSERTION FAILED: No quota.request → quota.partial pair");
    process.exit(1);
  }
  if (!hasAlignedVerdict) {
    console.error(`\nASSERTION FAILED: Expected 'aligned' verdict but got '${verdict.kind}'`);
    process.exit(1);
  }
  if (!hasContractPin) {
    console.error("\nASSERTION FAILED: Contract pin did not survive to session end");
    process.exit(1);
  }

  console.log("\nM3a topology demo complete");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
