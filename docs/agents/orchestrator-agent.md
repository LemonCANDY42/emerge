# Orchestrator Agent

Decompose goals into sub-tasks and route them to specialist workers. Typical use: large goals (write a book, run a campaign, build a product), divide-and-conquer execution.

## When to use

- **Big goal, many sub-tasks** — write 3 chapters, code 5 modules, analyze 10 datasets.
- **Sub-tasks are independent** — can run in parallel without coordination.
- **Different tools per sub-task** — one worker reads, another writes, another analyzes.
- **Need coordination + synthesis** — supervisor oversees, combines results.
- **Worker specialization matters** — each worker is an expert in its domain.

## Recommended blueprint (emerge-as-host)

Orchestrator (supervisor) spec:

```typescript
const orchestratorSpec: AgentSpec = {
  id: "supervisor-1",
  role: "supervisor",
  description: "Decomposes goals and coordinates worker teams",

  provider: {
    kind: "router",
    preference: ["anthropic", "openai"],
    criteria: {
      latencyTier: "interactive",
      maxUsdPerCall: 0.15,  // Meta-level reasoning, not content generation
    }
  },

  system: {
    kind: "literal",
    text: `You are a project supervisor. When given a large goal:
1. Break it into 3-5 independent sub-tasks
2. Describe what each worker should do
3. Wait for worker results
4. Combine and synthesize the final output
5. Report what was delegated and learned

Sub-tasks should be small enough for a specialist to complete in one "session".`
  },

  toolsAllowed: [
    "bus.send",           // Dispatch to workers
    "quota.request",      // Ask custodian for budget
    "memory.recall",      // Context from parent
  ],

  memoryView: {
    inheritFromSupervisor: true,
    writeTags: ["supervision", "delegation"],
    readFilter: { domain: "project" },
  },

  budget: {
    tokensIn: 30_000,    // Meta-reasoning; smaller context
    tokensOut: 5_000,    // Plan decomposition + synthesis
    usd: 1.0,            // Cheaper than workers; one per project
  },

  termination: {
    maxIterations: 5,    // Decompose, wait, synthesize
    maxWallMs: 3_600_000,  // 1 hour; workers run in parallel
    budget: { tokensIn: 30_000, tokensOut: 5_000 },
    retry: { transient: 2, nonRetryable: 0 },
    cycle: { windowSize: 3, repeatThreshold: 1 },
    done: {
      kind: "predicate",
      description: "Supervisor combines worker results and reports completion",
    }
  },

  acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
  capabilities: { tools: ["bus.send", "quota.request"], modalities: ["text"], qualityTier: "standard", streaming: true, interrupts: true, maxConcurrency: 1 },
  lineage: { depth: 0 },

  surveillance: "off",  // Supervisor role is fixed; don't adapt
};
```

Worker specs (example: research worker):

```typescript
const workerSpec: AgentSpec = {
  id: "worker-research-1",
  role: "worker",
  description: "Executes assigned research task",

  provider: { kind: "static", providerId: "anthropic" },

  system: {
    kind: "literal",
    text: "You are a research specialist. Complete the assigned sub-task and report results."
  },

  toolsAllowed: ["fs.read", "memory.recall"],
  memoryView: { inheritFromSupervisor: true, writeTags: ["findings"] },

  budget: {
    tokensIn: 50_000,
    tokensOut: 5_000,
    usd: 0.5,
  },

  termination: {
    maxIterations: 10,
    maxWallMs: 600_000,
    budget: { tokensIn: 50_000, tokensOut: 5_000 },
    retry: { transient: 2, nonRetryable: 0 },
    cycle: { windowSize: 5, repeatThreshold: 2 },
    done: { kind: "predicate", description: "end_turn" },
  },

  acl: { acceptsRequests: { allow: ["supervisor-1"] }, acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
  capabilities: { tools: ["fs.read"], modalities: ["text"], qualityTier: "standard", streaming: true, interrupts: true, maxConcurrency: 1 },
  lineage: { depth: 1, spawnedBy: "supervisor-1" },

  surveillance: "passive",
};
```

## SDK integration (emerge-as-client)

```typescript
import { supervisorWorker } from "@emerge/agents";

async function runOrchestratedTask(goal: string) {
  const kernel = new Kernel({ mode: "auto", reproducibility: "free" }, {});
  const provider = new AnthropicProvider();
  kernel.mountProvider(provider);

  const sessionId = `project-${Date.now()}` as SessionId;
  kernel.setSession(sessionId, "project-contract");

  const kernel: KernelLike = kernel;  // Implement KernelLike if not directly using Kernel

  const topology = supervisorWorker({
    supervisor: orchestratorSpec,
    workers: [workerResearchSpec, workerCodeSpec, workerDataSpec],
    dispatch: "parallel",  // Run workers concurrently
    aggregator: (results) => {
      // Combine worker results (or omit for LLM aggregation)
      return {
        research: results[0],
        code: results[1],
        data: results[2],
      };
    },
  });

  const result = await topology.run(goal, kernel, sessionId);
  if (result.ok) {
    console.log("Project output:", result.value);
    const cost = kernel.getCostMeter().ledger();
    console.log(`Total cost: $${cost.totals.grand.toFixed(4)}`);
  } else {
    console.error("Project failed:", result.error);
  }
}
```

## Recommended config defaults

| Field | Value | Why |
|---|---|---|
| **Supervisor** | | |
| `provider.tier` | Standard (Haiku/GPT-3.5) | Meta-reasoning; cheap |
| `budget.tokensIn` | 20k–30k | Plan, not content |
| `budget.tokensOut` | 3k–5k | Synthesis, not full generation |
| `maxIterations` | 3–5 | Decompose, wait, synthesize |
| `surveillance` | "off" | Fixed role; no decomposition |
| **Workers** | | |
| `provider.tier` | Varies (research=Haiku, code=Sonnet) | Per-worker specialization |
| `budget.tokensIn` | 50k–200k | Task-dependent |
| `budget.tokensOut` | 5k–20k | Task-dependent |
| `acl.acceptsRequests` | { allow: [supervisor.id] } | Restrict to supervisor |
| `lineage.spawnedBy` | supervisor.id | Record parent |
| `surveillance` | "passive" | Decompose on failure |
| **Topology** | | |
| `dispatch` | "parallel" (if independent) or "sequential" (if chained) | Depends on task DAG |
| `aggregator` | JS reducer or undefined (LLM aggregation) | M3c1: LLM aggregation default |

## Common pitfalls

1. **Supervisor never waits for workers** — Use `topology.run()` which blocks until all workers finish. Don't spawn workers and return immediately.

2. **Workers don't know what to do** — System prompt in worker spec must clearly state the assigned sub-task. Supervisor should send a `request` envelope with detailed instructions.

3. **Workers exceed their budget** — Set per-worker budgets conservatively. If a worker runs out of tokens mid-task, use surveillance: "active" to trigger decomposition.

4. **No aggregation logic** — If you omit `aggregator`, the supervisor agent is run via the bus and produces the final output (M3c1 default, LLM aggregation). Otherwise, provide a JS reducer function.

5. **Workers have open ACL** — Restrict `acl.acceptsRequests: { allow: [supervisor.id, custodianId?] }`. Open workers can be hijacked by other agents.

## Minimal invocation

```typescript
const topology = supervisorWorker({
  supervisor: {
    id: "sup",
    role: "supervisor",
    provider: { kind: "static", providerId: "mock" },
    system: { kind: "literal", text: "Decompose and coordinate." },
    toolsAllowed: ["bus.send"],
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    budget: { tokensIn: 30_000, tokensOut: 5_000, usd: 0.5 },
    termination: { maxIterations: 5, maxWallMs: 1_800_000, done: { kind: "predicate", description: "end_turn" } },
    acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
    capabilities: { tools: ["bus.send"], modalities: ["text"], qualityTier: "standard", streaming: true, interrupts: true, maxConcurrency: 1 },
    lineage: { depth: 0 },
    surveillance: "off",
  },
  workers: [workerSpec1, workerSpec2],
  dispatch: "parallel",
});

const result = await topology.run("Big goal here", kernel, sessionId);
```

## Links

- **Contracts:**
  - Topology: `packages/kernel/src/contracts/topology.ts`
  - Bus: `packages/kernel/src/contracts/bus.ts` (request/result envelopes)

- **Implementations:**
  - Supervisor/worker: `packages/agents/src/topologies/supervisor-worker.ts`
  - Example: `examples/topology-supervisor-worker/src/index.ts`

- **ADRs:**
  - ADR 0007: Topology as value (composition over inheritance)
  - ADR 0006: Streaming bus (how workers communicate)
  - ADR 0011: Custodian (optional; for quota management across workers)

- **Roadmap:**
  - [planned: M5] Mesh / tree / debate topologies (more patterns)
  - [planned: M5] Speculative branch-and-merge (parallel experiments + selection)
