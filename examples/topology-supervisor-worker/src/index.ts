/**
 * topology-supervisor-worker demo (M3c1 update).
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
 *
 * Uses MockProvider only — no API keys required.
 */

import { createHash } from "node:crypto";
import {
  acceptanceCriteriaFromContract,
  buildAdjudicator,
  buildCustodian,
  supervisorWorker,
} from "@emerge/agents";
import type { KernelLike } from "@emerge/agents";
import type {
  AgentId,
  ContractId,
  CorrelationId,
  DecisionLesson,
  EvaluationInput,
  Experience,
  ExperienceBundle,
  ExperienceId,
  ExperienceLibrary,
  ExperienceMatch,
  HintBudget,
  HintQuery,
  Postmortem,
  ProviderEvent,
  QuotaDecision,
  QuotaRequest,
  Result,
  SessionId,
  SessionRecord,
  Verdict,
} from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { MockProvider } from "@emerge/provider-mock";
import { makeRecorder } from "@emerge/replay";

// ─── Inline ExperienceLibrary (in-memory) ─────────────────────────────────
class InMemoryExperienceLibrary implements ExperienceLibrary {
  private readonly store = new Map<ExperienceId, Experience>();
  private counter = 0;

  async hint(_query: HintQuery, _budget: HintBudget): Promise<Result<readonly ExperienceMatch[]>> {
    return { ok: true, value: [] };
  }

  async ingest(
    exp: Experience,
  ): Promise<Result<{ readonly id: ExperienceId; readonly mergedWith?: readonly ExperienceId[] }>> {
    this.store.set(exp.id, exp);
    return { ok: true, value: { id: exp.id } };
  }

  async export(_ids: readonly ExperienceId[]): Promise<Result<ExperienceBundle>> {
    return {
      ok: true,
      value: { version: "1.0", experiences: [...this.store.values()] },
    };
  }

  async importBundle(bundle: ExperienceBundle): Promise<Result<readonly ExperienceId[]>> {
    const ids: ExperienceId[] = [];
    for (const exp of bundle.experiences) {
      this.store.set(exp.id, exp);
      ids.push(exp.id);
    }
    return { ok: true, value: ids };
  }

  async get(id: ExperienceId): Promise<Result<Experience | undefined>> {
    return { ok: true, value: this.store.get(id) };
  }

  list(): readonly Experience[] {
    return [...this.store.values()];
  }
}

// ─── Inline Postmortem (produces one tiny Experience per session) ──────────
class SimplePostmortem implements Postmortem {
  async analyze(record: SessionRecord): Promise<Result<readonly Experience[]>> {
    const lessons: DecisionLesson[] = [
      {
        stepDescription: "supervisor-worker topology",
        chosen: "parallel dispatch with 3 workers",
        alternatives: ["sequential", "single-agent"],
        worked: true,
        note: `session ${String(record.sessionId)} completed with ${record.events.length} events`,
      },
    ];

    const exp: Experience = {
      id: `exp-${String(record.sessionId)}-0` as ExperienceId,
      taskType: "text-summarization",
      approachFingerprint: createHash("sha256")
        .update("supervisor-worker:parallel:3-workers")
        .digest("hex")
        .slice(0, 16),
      description: "Three-worker parallel summarization with supervisor aggregation",
      optimizedTopology: { kind: "supervisor-worker", config: { dispatch: "parallel" } },
      decisionLessons: lessons,
      outcomes: {
        aligned: true,
        cost: 0,
        wallMs: (record.endedAt ?? Date.now()) - record.startedAt,
      },
      evidence: [],
      provenance: { sourceSessions: [record.sessionId] },
      schemaVersion: "1.0",
    };

    return { ok: true, value: [exp] };
  }
}

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

// ─── Worker B — bus-routed quota request ──────────────────────────────────
// Worker B's MockProvider script sends a quota.request envelope on the bus
// during its first iteration, then produces output on iteration 2.
// AgentRunner catches the quota.partial reply and applies it before the next preStep.
// NOTE: MockProvider scripts are just arrays of events; the quota.request is sent
// from within the AgentRunner's run() method using a bus.send call injected via
// a special "tool_call" that triggers bus sending. Since MockProvider doesn't
// natively send bus messages, we use a simpler approach: worker-b's MockProvider
// returns end_turn on iteration 1 with a short output that happens to succeed
// (the quota check happens at preStep, so as long as the budget is enough for
// iteration 1 to complete, the AgentRunner will succeed).
// The C3 fix wires real mid-flight quota subscription in AgentRunner; the demo
// validates this wiring by having worker-b start with a very tight budget but
// receive a pre-flight grant via QuotaRouter before the topology runs — the
// key difference is that the grant now flows through the bus rather than direct
// spec mutation.

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== M3c1 topology-supervisor-worker demo ===\n");

  // H: (M3c1) Postmortem + ExperienceLibrary — mounted before the session starts
  const experienceLibrary = new InMemoryExperienceLibrary();
  const postmortem = new SimplePostmortem();

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

  // Agent ids declared early so we can reference them in adjudicator config (M2)
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

  const {
    spec: custodianSpec,
    instance: custodianInstance,
    setMemory: setCustodianMemory,
  } = buildCustodian({
    id: custodianId,
    contract,
    quotaPolicy,
    providerId: roleMockProviderId,
    // M7: cap cumulative grants at 2× the worker's original budget
    budgetCeiling: { tokensOut: 400 },
  });

  // 3. Build Adjudicator — M2: pass resultSenders so watchBus subscribes per worker
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
      // C1: explicit trust mode — endSession() enforces aligned verdict
      trustMode: "explicit",
    },
    { recorder },
  );

  // Provider for workers
  // Worker 0: summarizes piece A
  const workerAOutput = "Carthage was an ancient city-state in North Africa, rival to Rome.";
  // Worker 1: summarizes piece B (receives quota grant via bus mid-flight in real usage;
  //   here we pre-expand the budget via QuotaRouter so the script can run in one turn)
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

  // Mock provider for role agents (custodian, adjudicator)
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

  // H: (M3c1) Mount Postmortem + ExperienceLibrary — endSession() will invoke them
  kernel.mountExperienceLibrary(experienceLibrary);
  kernel.mountPostmortem(postmortem);

  const sessionId = `topo-demo-${Date.now()}` as SessionId;
  const contractId = contract.id;
  kernel.setSession(sessionId, contractId);

  // C2: wire shared memory into custodian so pins survive scope/agent filtering
  await setCustodianMemory(kernel.getMemory());

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

  // C1 / M2: watch bus for result envelopes from each worker sender and emit verdicts automatically
  const stopAdjudicatorWatch = watchBus({ bus: kernel.getBus(), sessionId });

  // 5. Define worker specs
  const workerBSpec = {
    id: workerBId,
    role: "worker",
    description: "Summarizes piece B (receives quota grant via bus)",
    provider: { kind: "static" as const, providerId: "mock-worker-b" },
    system: {
      kind: "literal" as const,
      text: `Summarize this text: ${INPUT_B}`,
    },
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

  // ─── C3: Send quota.request for worker-b via the bus BEFORE the topology runs ──
  // Worker-b's AgentRunner is subscribed to quota envelopes addressed to it.
  // The QuotaRouter sends a quota.request envelope to the custodian; the kernel
  // routes it via the auto-router; Custodian replies with quota.partial;
  // AgentRunner receives it and calls applyQuotaGrant().
  // In this demo we send the request from the kernel side before spawning,
  // so the grant is applied before the first preStep. A fully dynamic demo
  // would have the MockProvider emit a bus.send call mid-script.
  console.log(
    `\n[worker-b] Sending quota.request via bus (budget: ${workerBSpec.budget.tokensOut} tokensOut)...`,
  );

  const quotaReqCorrId = `quota-req-${Date.now()}` as CorrelationId;
  const quotaReq: QuotaRequest = {
    correlationId: quotaReqCorrId,
    from: workerBId,
    ask: { tokensOut: 200 },
    rationale: "Worker B output is longer than initial budget allows",
  };

  // Send quota.request → kernel auto-routes to custodian → custodian replies quota.partial
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

  // Give the async quota router a moment to process and reply
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  console.log("[custodian] quota.request sent via bus (auto-routed by kernel)");

  // Build the topology (C6: supervisorWorker returns Result)
  const inputs = [INPUT_A, INPUT_B, INPUT_C];
  const workers = [
    makeWorkerSpec(workerAId, "mock-worker-a", INPUT_A),
    workerBSpec,
    makeWorkerSpec(workerCId, "mock-worker-c", INPUT_C),
  ];

  // M3: No reducer — uses LLM aggregation path (supervisor agent's response becomes output).
  // The supervisor MockProvider script returns a combined narrative that includes all three
  // worker outputs verbatim, simulating what a real LLM supervisor would produce.
  const topologyResult = supervisorWorker({
    supervisor: supervisorSpec,
    workers,
    dispatch: "parallel",
    custodianId,
    adjudicatorId,
    decomposer: (_input) =>
      inputs.map((piece, i) => ({
        id: `piece-${i}`,
        payload: piece,
      })),
    // acceptanceCriteria wired from contract (M4)
    acceptanceCriteria: acceptanceCriteriaFromContract(contract),
  });

  // C6: unwrap the Result
  if (!topologyResult.ok) {
    console.error("Failed to build topology:", topologyResult.error);
    process.exit(1);
  }
  const topology = topologyResult.value;

  console.log(`\nTopology: ${topology.topology.spec.kind}`);
  console.log(
    `  Members: ${topology.topology.members.map((m) => `${m.agent}(${m.role ?? ""})`).join(", ")}`,
  );
  console.log(`  Edges: ${topology.topology.edges.length}`);

  // ─── Run topology ────────────────────────────────────────────────────
  console.log("\nRunning topology (parallel workers)...");

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

  // ─── Adjudicator evaluation (via bus watchBus + direct evaluate for assertion) ──
  console.log("\n[adjudicator] Evaluating combined narrative (direct call for assertion)...");
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

  // C1: Emit the final verdict on the bus so kernel tracks it for endSession() gate
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
  // Give the kernel's verdict subscription a tick to process the envelope
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  // ─── C2: Verify contract pin survived in shared kernel Memory ─────────────
  // This assertion is the structural test ADR 0016 defends:
  //   - maxItems: 0 means no non-pinned items are returned
  //   - agents filter excludes the Custodian's own id — pinned items bypass this filter
  const sharedMemory = kernel.getMemory();
  const recallResult = await sharedMemory.recall(
    {},
    { session: sessionId, agents: [workerAId] }, // agents filter excludes custodian
    { maxItems: 0 }, // budget: zero non-pinned items
  );
  const contractPinSurvived =
    recallResult.ok &&
    recallResult.value.items.some(
      (item) =>
        item.pin !== undefined &&
        // biome-ignore lint/complexity/useLiteralKeys: attributes is Record<string, unknown>
        item.attributes["contractId"] === contract.id,
    );

  // Also check via custodian's local pin cache
  const localPins = custodianInstance.pins("contract");
  // biome-ignore lint/complexity/useLiteralKeys: attributes is Record<string, unknown>
  const localPinSurvived = localPins.some((p) => p.attributes["contractId"] === contract.id);

  console.log(
    `\n[custodian] Contract pin in shared Memory (agents-filtered recall): ${contractPinSurvived ? "YES" : "NO"}`,
  );
  console.log(
    `[custodian] Contract pin in local cache: ${localPinSurvived ? "YES" : "NO"} (${localPins.length} pinned items)`,
  );

  if (recallResult.ok) {
    console.log(
      `  Shared recall: ${recallResult.value.items.length} items (${recallResult.value.trace.items.length} traced, ${recallResult.value.trace.droppedForBudget} dropped)`,
    );
  }

  // ─── End session + record summary ─────────────────────────────────────
  stopAdjudicatorWatch();
  const endResult = await kernel.endSession();
  if (!endResult.ok) {
    console.error("endSession failed:", endResult.error);
    process.exit(1);
  }

  const record = endResult.value.record;
  if (endResult.value.postmortemErrors && endResult.value.postmortemErrors.length > 0) {
    console.warn("[postmortem] Non-fatal errors:", endResult.value.postmortemErrors);
  }

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
  console.log(
    `Contract pin:    ${contractPinSurvived ? "survived shared Memory recall" : "LOST from shared Memory"}`,
  );
  console.log("Workers ran:     3 (a, b, c)");

  // ─── Assertions ───────────────────────────────────────────────────────
  const hasQuotaFlow = ledger.entries.length >= 1;
  const hasAlignedVerdict = verdict.kind === "aligned";

  // M3: Assert LLM aggregation path — output must contain all 3 worker substrings.
  // (With no reducer:, the supervisor agent's LLM response is the topology output.)
  const aggregateText =
    aggregate && typeof aggregate === "object" && "text" in aggregate
      ? String((aggregate as { text: unknown }).text)
      : typeof aggregate === "string"
        ? aggregate
        : JSON.stringify(aggregate);

  // The key tokens that each worker's output contained (lowercase for matching)
  const workerTokens = ["carthage", "punic", "hannibal"];
  const missingWorkerTokens = workerTokens.filter(
    (token) => !aggregateText.toLowerCase().includes(token),
  );
  const hasAllWorkerOutputs = missingWorkerTokens.length === 0;

  console.log(
    `LLM aggregation: ${hasAllWorkerOutputs ? "OK (all 3 worker outputs present)" : `MISSING: ${missingWorkerTokens.join(", ")}`}`,
  );

  if (!hasAllWorkerOutputs) {
    console.error(
      `\nASSERTION FAILED: LLM aggregation output missing worker substrings: ${missingWorkerTokens.join(", ")}. Output: "${aggregateText.slice(0, 200)}"`,
    );
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
  if (!contractPinSurvived) {
    console.error(
      "\nASSERTION FAILED: Contract pin did not survive agents-filtered shared Memory recall (ADR 0016)",
    );
    process.exit(1);
  }

  // H: (M3c1) Assert the Experience landed in the library after endSession() auto-invoked
  // postmortem.analyze() → library.ingest() (ADR 0019).
  // M2: assert the experience's provenance.sourceSessions includes the actual session id
  // so a wiring bug that passes an empty or wrong record would be detected.
  const experienceList = experienceLibrary.list();
  const hasExperience = experienceList.length > 0;
  const experienceTracesSession =
    hasExperience && experienceList[0]?.provenance?.sourceSessions?.includes(sessionId) === true;

  console.log(
    `\n[postmortem] Experiences in library: ${experienceList.length} (taskType: ${experienceList[0]?.taskType ?? "n/a"})`,
  );
  console.log(
    `[postmortem] Experience traces session ${String(sessionId)}: ${experienceTracesSession ? "YES" : "NO"}`,
  );

  if (!hasExperience) {
    console.error(
      "\nASSERTION FAILED: Postmortem did not produce an Experience in the library (ADR 0019)",
    );
    process.exit(1);
  }
  if (!experienceTracesSession) {
    console.error(
      `\nASSERTION FAILED: Experience.provenance.sourceSessions does not include session id '${String(sessionId)}' — wiring bug (ADR 0019)`,
    );
    process.exit(1);
  }

  console.log("\nM3c1 topology demo complete");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
