/**
 * topology-supervisor-worker demo (M3c2.5 update).
 *
 * Exercises:
 *   A. LocalFsArtifactStore
 *   B. Custodian + quota flow (bus-routed: worker-b sends quota.request on iteration 1;
 *      AgentRunner intercepts the quota.partial and applies the grant in-flight)
 *   C. Adjudicator (bus-watched: watchBus subscribes per worker sender; emits verdict envelope;
 *      kernel tracks verdict; endSession() enforces aligned gate)
 *   D. supervisorWorker topology (1 supervisor + 3 workers, parallel)
 *   E. Pinned-context (contract pin written into shared kernel Memory via setMemory();
 *      verified via kernel.getMemory().recall() with maxItems:0 + agents filter that
 *      excludes the Custodian — pinned items survive both constraints by ADR 0016)
 *   F. Quota auto-routing (kernel routes quota.request → Custodian → quota.partial → AgentRunner)
 *   G. SessionRecord summary on exit
 *   H. (M3c1) Postmortem auto-invoke: mounted Postmortem + ExperienceLibrary, asserts
 *      that the Experience lands in the library after endSession() (ADR 0019).
 *   I. (M3c2.5) Experience loop: run the same task TWICE with a shared in-memory library.
 *      Run 1 produces zero hints; Run 2 sees the experience from Run 1. Uses the
 *      real InMemoryExperienceLibrary package + stable defaultAnalyze fingerprinting.
 *
 * Uses MockProvider only — no API keys required.
 */

import { createHash } from "node:crypto";
import {
  acceptanceCriteriaFromContract,
  buildAdjudicator,
  buildCustodian,
  buildPostmortem,
  defaultAnalyze,
  supervisorWorker,
} from "@emerge/agents";
import type { KernelLike } from "@emerge/agents";
import { InMemoryExperienceLibrary } from "@emerge/experience-inmemory";
import type {
  AgentId,
  ContractId,
  CorrelationId,
  EvaluationInput,
  Experience,
  ExperienceBundle,
  ExperienceId,
  ExperienceLibrary,
  ExperienceMatch,
  HintBudget,
  HintQuery,
  ProviderEvent,
  QuotaDecision,
  QuotaRequest,
  Result,
  SessionId,
  Verdict,
} from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
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

// ─── HintCounting wrapper ─────────────────────────────────────────────────
// Wraps an ExperienceLibrary to count calls to hint() that returned results.
// This lets the demo observe how many times surveillance received experience hints.
class HintCountingLibrary implements ExperienceLibrary {
  private _hintCallsWithResults = 0;

  constructor(private readonly inner: InMemoryExperienceLibrary) {}

  async hint(query: HintQuery, budget: HintBudget): Promise<Result<readonly ExperienceMatch[]>> {
    const result = await this.inner.hint(query, budget);
    if (result.ok && result.value.length > 0) {
      this._hintCallsWithResults++;
    }
    return result;
  }

  async ingest(
    exp: Experience,
  ): Promise<Result<{ readonly id: ExperienceId; readonly mergedWith?: readonly ExperienceId[] }>> {
    return this.inner.ingest(exp);
  }

  async export(ids: readonly ExperienceId[]): Promise<Result<ExperienceBundle>> {
    return this.inner.export(ids);
  }

  async importBundle(bundle: ExperienceBundle): Promise<Result<readonly ExperienceId[]>> {
    return this.inner.importBundle(bundle);
  }

  async get(id: ExperienceId): Promise<Result<Experience | undefined>> {
    return this.inner.get(id);
  }

  hintCallsWithResults(): number {
    return this._hintCallsWithResults;
  }

  resetHintCount(): void {
    this._hintCallsWithResults = 0;
  }

  size(): number {
    return this.inner.size();
  }
}

// ─── Single topology run ──────────────────────────────────────────────────
async function runTopology(
  runLabel: string,
  sessionId: SessionId,
  experienceLibrary: HintCountingLibrary,
): Promise<{ verdict: Verdict; experienceCount: number; hintsWithResults: number }> {
  console.log(`\n${"=".repeat(55)}`);
  console.log(`  ${runLabel}`);
  console.log("=".repeat(55));

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

  // Agent ids
  const supervisorId = "supervisor-1" as AgentId;
  const workerAId = "worker-a" as AgentId;
  const workerBId = "worker-b" as AgentId;
  const workerCId = "worker-c" as AgentId;
  const custodianId = "custodian-1" as AgentId;
  const adjudicatorId = "adjudicator-1" as AgentId;

  // 2. Build Custodian
  let quotaRequestCount = 0;
  const quotaPolicy = (req: QuotaRequest): QuotaDecision => {
    quotaRequestCount++;
    const askedOut = req.ask.tokensOut ?? 0;
    if (quotaRequestCount === 1 && askedOut > 0) {
      const grantedOut = Math.floor(askedOut * 0.5);
      console.log(
        `[custodian] quota.request from ${req.from}: asked +${askedOut} tokensOut → granting +${grantedOut} (50%)`,
      );
      return {
        kind: "partial",
        granted: { tokensOut: grantedOut },
        rationale: "Granting 50% extra tokensOut for first request",
      };
    }
    return { kind: "deny", reason: "Policy: only one quota approval per session" };
  };

  const roleMockProviderId = "mock-role";

  const {
    spec: custodianSpec,
    instance: custodianInstance,
    setMemory: setCustodianMemory,
  } = buildCustodian({
    id: custodianId,
    contract,
    quotaPolicy,
    providerId: roleMockProviderId,
    budgetCeiling: { tokensOut: 400 },
  });

  // 3. Build Adjudicator
  const {
    spec: adjudicatorSpec,
    instance: adjudicatorInstance,
    watchBus,
  } = buildAdjudicator({
    id: adjudicatorId,
    contract,
    providerId: roleMockProviderId,
    resultSenders: [workerAId, workerBId, workerCId, supervisorId],
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

  // 4. Postmortem (M3c2.5: real defaultAnalyze with stable fingerprinting)
  const { instance: postmortemInstance } = buildPostmortem({
    id: "postmortem-1" as AgentId,
    analyze: defaultAnalyze,
  });

  // 5. Build Kernel (fresh per run — shared library persists across runs)
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
      trustMode: "explicit",
    },
    { recorder },
  );

  // Providers
  const workerAOutput = "Carthage was an ancient city-state in North Africa, rival to Rome.";
  const workerBOutput =
    "The Punic Wars (264–146 BC) were three conflicts between Rome and Carthage; Rome ultimately won.";
  const workerCOutput =
    "Hannibal Barca crossed the Alps with war elephants to invade Rome during the Second Punic War.";

  const providerA = new MockProvider(makeWorkerScript(workerAOutput), "mock-worker-a");
  const providerB = new MockProvider(makeWorkerScript(workerBOutput), "mock-worker-b");
  const providerC = new MockProvider(makeWorkerScript(workerCOutput), "mock-worker-c");

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

  kernel.mountCustodian(custodianInstance);

  // I. (M3c2.5) Mount the shared experience library + postmortem with stable fingerprinting
  kernel.mountExperienceLibrary(experienceLibrary);
  kernel.mountPostmortem(postmortemInstance);

  kernel.setSession(sessionId, contract.id);
  await setCustodianMemory(kernel.getMemory());

  const spawnCustodian = await kernel.spawn(custodianSpec);
  if (!spawnCustodian.ok) {
    console.error("Failed to spawn custodian:", spawnCustodian.error);
    process.exit(1);
  }

  const spawnAdjudicator = await kernel.spawn(adjudicatorSpec);
  if (!spawnAdjudicator.ok) {
    console.error("Failed to spawn adjudicator:", spawnAdjudicator.error);
    process.exit(1);
  }

  const stopAdjudicatorWatch = watchBus({ bus: kernel.getBus(), sessionId });

  // Worker specs
  const workerBSpec = {
    id: workerBId,
    role: "worker",
    description: "Summarizes piece B (receives quota grant via bus)",
    provider: { kind: "static" as const, providerId: "mock-worker-b" },
    system: { kind: "literal" as const, text: `Summarize this text: ${INPUT_B}` },
    toolsAllowed: [] as readonly string[],
    memoryView: { inheritFromSupervisor: false, writeTags: [] as string[] },
    budget: { tokensIn: 2_000, tokensOut: 200 },
    termination: {
      maxIterations: 5,
      maxWallMs: 30_000,
      budget: { tokensIn: 2_000, tokensOut: 200 },
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
      maxConcurrency: 3,
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

  // Quota request for worker-b
  console.log("[worker-b] Sending quota.request via bus...");
  const quotaReqCorrId = `quota-req-${Date.now()}` as CorrelationId;
  const quotaReq: QuotaRequest = {
    correlationId: quotaReqCorrId,
    from: workerBId,
    ask: { tokensOut: 200 },
    rationale: "Worker B output is longer than initial budget allows",
  };
  const busSendResult = await kernel.getBus().send({
    kind: "quota.request",
    correlationId: quotaReqCorrId,
    sessionId,
    from: workerBId,
    to: { kind: "agent", id: custodianId },
    timestamp: Date.now(),
    request: quotaReq,
  });
  if (!busSendResult.ok) {
    console.error("quota.request send failed:", busSendResult.error);
    process.exit(1);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  // Build topology
  const inputs = [INPUT_A, INPUT_B, INPUT_C];
  const workers = [
    makeWorkerSpec(workerAId, "mock-worker-a", INPUT_A),
    workerBSpec,
    makeWorkerSpec(workerCId, "mock-worker-c", INPUT_C),
  ];

  const topologyResult = supervisorWorker({
    supervisor: supervisorSpec,
    workers,
    dispatch: "parallel",
    custodianId,
    adjudicatorId,
    decomposer: (_input) => inputs.map((piece, i) => ({ id: `piece-${i}`, payload: piece })),
    acceptanceCriteria: acceptanceCriteriaFromContract(contract),
  });

  if (!topologyResult.ok) {
    console.error("Failed to build topology:", topologyResult.error);
    process.exit(1);
  }
  const topology = topologyResult.value;

  console.log("\nRunning topology (parallel workers)...");
  const kernelLike: KernelLike = kernel;
  const topoResult = await topology.run(inputs.join("\n"), kernelLike, sessionId);

  if (!topoResult.ok) {
    console.error("Topology run failed:", topoResult.error);
    process.exit(1);
  }

  const aggregate = topoResult.value;
  const aggregateText =
    aggregate && typeof aggregate === "object" && "text" in aggregate
      ? String((aggregate as { text: unknown }).text)
      : typeof aggregate === "string"
        ? aggregate
        : JSON.stringify(aggregate);

  // Adjudicator evaluation
  const evalInput: EvaluationInput = {
    outputs: { combined: aggregate },
    artifacts: [],
    rationale: "Supervisor-aggregated narrative from 3 workers",
  };
  const verdict = await adjudicatorInstance.evaluate(evalInput);
  console.log(`[adjudicator] Verdict: ${verdict.kind}`);

  // Emit verdict on bus so kernel tracks it for endSession() gate
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
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  // Verify contract pin in shared Memory (ADR 0016)
  const sharedMemory = kernel.getMemory();
  const recallResult = await sharedMemory.recall(
    {},
    { session: sessionId, agents: [workerAId] },
    { maxItems: 0 },
  );
  const contractPinSurvived =
    recallResult.ok &&
    recallResult.value.items.some(
      // biome-ignore lint/complexity/useLiteralKeys: attributes is Record<string, unknown>
      (item) => item.pin !== undefined && item.attributes["contractId"] === contract.id,
    );

  console.log(`[custodian] Contract pin in shared Memory: ${contractPinSurvived ? "YES" : "NO"}`);

  // End session — postmortem fires automatically → ingest into experienceLibrary
  stopAdjudicatorWatch();
  const endResult = await kernel.endSession();
  if (!endResult.ok) {
    console.error("endSession failed:", endResult.error);
    process.exit(1);
  }

  if (endResult.value.postmortemErrors && endResult.value.postmortemErrors.length > 0) {
    console.warn("[postmortem] Non-fatal errors:", endResult.value.postmortemErrors);
  }

  const missingWorkerTokens = KEY_TOKENS.filter(
    (token) => !aggregateText.toLowerCase().includes(token),
  );

  // Assertions
  if (missingWorkerTokens.length > 0) {
    console.error(
      `\nASSERTION FAILED: LLM aggregation missing tokens: ${missingWorkerTokens.join(", ")}`,
    );
    process.exit(1);
  }
  if (!contractPinSurvived) {
    console.error(
      "\nASSERTION FAILED: Contract pin did not survive agents-filtered shared Memory recall",
    );
    process.exit(1);
  }
  if (verdict.kind !== "aligned") {
    console.error(`\nASSERTION FAILED: Expected 'aligned' verdict but got '${verdict.kind}'`);
    process.exit(1);
  }

  const hintsWithResults = experienceLibrary.hintCallsWithResults();
  return { verdict, experienceCount: experienceLibrary.size(), hintsWithResults };
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== M3c2.5 topology-supervisor-worker demo ===\n");
  console.log("Goal: prove the postmortem→experience→surveillance loop runs end-to-end.");
  console.log("The same task is executed TWICE with a shared in-memory experience library.");
  console.log("Run 1: library is empty → zero experience hints seen by surveillance.");
  console.log("Run 2: library has Run 1's experience → hints flow to surveillance.\n");

  // The shared experience library persists across both runs.
  const innerLibrary = new InMemoryExperienceLibrary();
  const experienceLibrary = new HintCountingLibrary(innerLibrary);

  // ─── Run 1 ────────────────────────────────────────────────────────────
  experienceLibrary.resetHintCount();
  const session1 = `topo-demo-run1-${Date.now()}` as SessionId;
  const run1 = await runTopology("Run 1 — no priors", session1, experienceLibrary);

  console.log(`\n[run-1] Experiences in library after run: ${run1.experienceCount}`);
  console.log(`[run-1] Hint calls with results during run: ${run1.hintsWithResults}`);

  // ─── Run 2 ────────────────────────────────────────────────────────────
  // Reset hint counter so we measure only run 2's hints.
  experienceLibrary.resetHintCount();
  const session2 = `topo-demo-run2-${Date.now()}` as SessionId;
  const run2 = await runTopology("Run 2 — with priors from Run 1", session2, experienceLibrary);

  console.log(`\n[run-2] Experiences in library after run: ${run2.experienceCount}`);
  console.log(`[run-2] Hint calls with results during run: ${run2.hintsWithResults}`);

  // ─── Experience Loop Summary ───────────────────────────────────────────
  console.log("\n══════════════════════════════════════════");
  console.log("  EXPERIENCE LOOP SUMMARY (M3c2.5)");
  console.log("══════════════════════════════════════════");
  console.log(`Run 1: no priors → ${run1.hintsWithResults} hint calls with results`);
  console.log(
    `Run 2: ${run1.experienceCount} prior(s) → ${run2.hintsWithResults} hint calls with results`,
  );

  // Determine whether merging happened (same approach fingerprint → merged)
  if (run2.experienceCount === run1.experienceCount) {
    console.log(
      `\nLibrary size: ${run2.experienceCount} (Run 2 MERGED into Run 1's experience — same approach fingerprint).`,
    );
  } else {
    console.log(
      `\nLibrary size: ${run2.experienceCount} (Run 2 added a new entry — fingerprints differ).`,
    );
  }

  console.log("\nObservation: surveillance received experience hints on Run 2 because");
  console.log("defaultAnalyze now produces stable approachFingerprints keyed on session");
  console.log("structure (tools + surveillance + decisions), not on session identity.");

  // ─── Assertions ───────────────────────────────────────────────────────
  // Run 1 must have zero hints with results (library was empty).
  if (run1.hintsWithResults !== 0) {
    console.error(
      `\nASSERTION FAILED: Run 1 expected 0 hint calls with results, got ${run1.hintsWithResults}`,
    );
    process.exit(1);
  }

  // Library must have at least one experience after Run 1.
  if (run1.experienceCount === 0) {
    console.error(
      "\nASSERTION FAILED: Library empty after Run 1 — postmortem→ingest wiring broken (ADR 0019)",
    );
    process.exit(1);
  }

  // Run 2 must have seen at least one hint with results (library was non-empty).
  if (run2.hintsWithResults === 0) {
    console.error(
      "\nASSERTION FAILED: Run 2 expected >0 hint calls with results — experience hints not flowing to surveillance",
    );
    process.exit(1);
  }

  console.log("\nAll M3c2.5 assertions passed. Experience loop is end-to-end.");
  console.log("M3c2.5 topology demo complete.");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
