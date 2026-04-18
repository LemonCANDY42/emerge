# Postmortem Agent

Analyze completed sessions and extract lessons for future re-use. Session-over-session learning: fail once, learn once, succeed always.

## When to use

- **Repeated task types** — similar tasks appear multiple times; learn patterns.
- **Expensive tasks** — $10+ per task; learning pays for itself fast.
- **Complex workflows** — capture what worked and what didn't.
- **Batch operations** — process 100 tasks; get smarter on #101.

## Recommended blueprint (emerge-as-host)

Postmortem agents are **batch analyzers**, not live loop agents. They run *after* a session completes.

```typescript
// Postmortem agents don't have a traditional AgentSpec because they don't run
// in a loop. Instead, implement the Postmortem interface:

class MyPostmortem implements Postmortem {
  async analyze(record: SessionRecord): Promise<Result<readonly Experience[]>> {
    // Given a session record, extract lessons
    const experiences: Experience[] = [];

    // 1. Find what worked (progress envelopes)
    const progressEnvelopes = record.events
      .filter(e => e.kind === "envelope" && (e as any).envelope.kind === "progress")
      .map(e => (e as any).envelope);

    // 2. Find verdicts
    const verdictEnvelopes = record.events
      .filter(e => e.kind === "envelope" && (e as any).envelope.kind === "verdict")
      .map(e => (e as any).envelope);

    const hasAlignedVerdict = verdictEnvelopes.some(e => e.verdict.kind === "aligned");

    // 3. Combine into Experience
    if (progressEnvelopes.length > 0 || verdictEnvelopes.length > 0) {
      experiences.push({
        id: `exp-${record.sessionId}` as ExperienceId,
        taskType: "multi-agent-decomposition",
        approachFingerprint: "supervisor-worker-topology",
        description: "Decomposition with parallel workers was effective",
        optimizedTopology: {
          kind: "supervisor-worker",
          supervisor: { id: "supervisor" as AgentId, role: "supervisor" },
          workers: [],
          dispatch: "parallel",
        },
        decisionLessons: [
          {
            stepDescription: "Use parallel worker topology",
            chosen: "parallel",
            worked: hasAlignedVerdict,
          }
        ],
        outcomes: {
          aligned: hasAlignedVerdict,
          cost: 5.0,
          wallMs: Date.now() - record.startedAt,
        },
        evidence: [],
        provenance: { sourceSessions: [record.sessionId] },
        schemaVersion: "1.0",
      });
    }

    return { ok: true, value: experiences };
  }
}
```

## SDK integration (emerge-as-client)

```typescript
import type { Postmortem, SessionRecord, Experience, ExperienceId, AgentId } from "@emerge/kernel/contracts";

const myPostmortem: Postmortem = {
  analyze: async (record: SessionRecord): Promise<Result<readonly Experience[]>> => {
    const experiences: Experience[] = [];

    // Analyze the session record to extract lessons
    const envelopes = record.events
      .filter(e => e.kind === "envelope")
      .map(e => (e as any).envelope);

    const resultEnvelopes = envelopes.filter(e => e.kind === "result");
    const verdictEnvelopes = envelopes.filter(e => e.kind === "verdict");

    // Extract a lesson
    if (resultEnvelopes.length > 0 || verdictEnvelopes.length > 0) {
      experiences.push({
        id: `exp-${record.sessionId}` as ExperienceId,
        taskType: "divide-and-conquer",
        approachFingerprint: "parallel-worker-decomposition",
        description: "Spawning 5 parallel workers proved effective",
        optimizedTopology: {
          kind: "supervisor-worker",
          supervisor: { id: "supervisor" as AgentId, role: "supervisor" },
          workers: [],
          dispatch: "parallel",
        },
        decisionLessons: [
          {
            stepDescription: "Use parallel workers for large tasks",
            chosen: "parallel-workers",
            worked: true,
          }
        ],
        outcomes: {
          aligned: verdictEnvelopes.some(e => e.verdict.kind === "aligned"),
          cost: 0.25,  // Estimate from tokens/usage
          wallMs: (record.endedAt ?? Date.now()) - record.startedAt,
        },
        evidence: [],
        provenance: { sourceSessions: [record.sessionId] },
        schemaVersion: "1.0",
      });
    }

    return { ok: true, value: experiences };
  },
};

const kernel = new Kernel({ ... }, {});
kernel.mountPostmortem(myPostmortem);

// Run a session
const sessionId = `session-${Date.now()}` as SessionId;
kernel.setSession(sessionId, contractId);
await kernel.spawn(agentSpec);
await kernel.runAgent(handle);

// On endSession(), postmortem is auto-invoked if ExperienceLibrary is also mounted
const endResult = await kernel.endSession();
if (endResult.ok) {
  console.log("Session ended; postmortem analyzed lessons");
}
```

## Experience library

Store and retrieve experiences:

```typescript
import type { ExperienceLibrary, Experience, ExperienceMatch, HintQuery, HintBudget } from "@emerge/kernel/contracts";

// Mount the library
const library: ExperienceLibrary = ...;  // e.g., InMemoryExperienceLibrary (demo), SQLite-backed (M5)
kernel.mountExperienceLibrary(library);

// Postmortem ingests experiences after each session
const ingestResult = await library.ingest(experience);

// Future agents query hints before running
const hintQuery: HintQuery = {
  approachFingerprint: "supervisor-decomposition",
  taskType: "multi-agent-task",
  description: "Decompose large goal into sub-tasks",
};
const hintBudget: HintBudget = { maxItems: 3, maxTokens: 1000 };
const hints = await library.hint(hintQuery, hintBudget);

// Surveillance uses hints as priors
const recommendation = await surveillance.assess({
  ...input,
  experienceHints: hints.value,
});
```

## Recommended config defaults

| Field | Value | Why |
|---|---|---|
| **Postmortem** (not an agent; a batch analyzer) | | |
| Input | SessionRecord | Completed session artifact |
| Output | Experience[] | Extracted lessons |
| Trigger | kernel.endSession() | Auto-invoke when library mounted |
| Latency | Async (seconds) | Batch; not latency-critical |
| Cost | Free (no model calls in M3a) | Deterministic analysis |

## Common patterns

### Pattern 1: Extract decision lessons

```typescript
async analyze(record: SessionRecord): Promise<Result<readonly Experience[]>> {
  const envelopes = record.events
    .filter(e => e.kind === "envelope")
    .map(e => (e as any).envelope);

  const progressEnvelopes = envelopes.filter(e => e.kind === "progress");

  const decisionLessons = progressEnvelopes.map((pe, idx) => ({
    stepDescription: pe.step ?? `Step ${idx}`,
    chosen: pe.currentTool ?? "unknown",
    worked: true,  // Infer from later verdicts if needed
  }));

  return { ok: true, value: [{
    id: `exp-${record.sessionId}` as ExperienceId,
    taskType: "supervisor-worker",
    approachFingerprint: record.contractRef,
    description: "Multi-step task with progress tracking",
    optimizedTopology: { kind: "supervisor-worker", config: { dispatch: "parallel" } },
    decisionLessons,
    outcomes: { aligned: true, cost: 0.5, wallMs: (record.endedAt ?? Date.now()) - record.startedAt },
    evidence: [],
    provenance: { sourceSessions: [record.sessionId] },
    schemaVersion: "1.0",
  }] };
}
```

### Pattern 2: Cost-effectiveness analysis

```typescript
async analyze(record: SessionRecord): Promise<Result<readonly Experience[]>> {
  const providerCalls = record.events.filter(e => e.kind === "provider_call");
  let costUsd = 0;
  for (const pc of providerCalls) {
    for (const event of (pc as any).events) {
      if (event.type === "stop") costUsd += event.usage?.usd ?? 0;
    }
  }

  const duration = (record.endedAt ?? Date.now()) - record.startedAt;
  const costPerMinute = duration > 0 ? costUsd / (duration / 60000) : 0;

  return { ok: true, value: [{
    id: `exp-${record.sessionId}` as ExperienceId,
    taskType: "cost-optimization",
    approachFingerprint: costPerMinute > 1.0 ? "use-strong-model" : "use-weak-model",
    description: `Cost: $${costUsd.toFixed(4)} (${costPerMinute.toFixed(2)}/min)`,
    optimizedTopology: { kind: "supervisor-worker", config: { dispatch: "parallel" } },
    decisionLessons: [{
      stepDescription: "Model selection",
      chosen: costPerMinute > 1.0 ? "Upgrade to stronger model" : "Weak model sufficient",
      worked: true,
    }],
    outcomes: { aligned: true, cost: costUsd, wallMs: duration },
    evidence: [],
    provenance: { sourceSessions: [record.sessionId] },
    schemaVersion: "1.0",
  }] };
}
```

### Pattern 3: Topology effectiveness

```typescript
async analyze(record: SessionRecord): Promise<Result<readonly Experience[]>> {
  const envelopes = record.events
    .filter(e => e.kind === "envelope")
    .map(e => (e as any).envelope);

  const progressCount = envelopes.filter(e => e.kind === "progress").length;
  const isParallel = progressCount > 3;
  const wasEffective = envelopes.some(e => e.kind === "verdict" && e.verdict.kind === "aligned");

  return { ok: true, value: [{
    id: `exp-${record.sessionId}` as ExperienceId,
    taskType: "topology-selection",
    approachFingerprint: isParallel ? "parallel-workers" : "sequential-workflow",
    description: `Topology: ${isParallel ? "parallel" : "sequential"}; Effective: ${wasEffective}`,
    optimizedTopology: isParallel ? { kind: "supervisor-worker", config: { dispatch: "parallel" } } : { kind: "pipeline", config: {} },
    decisionLessons: [{
      stepDescription: "Topology choice",
      chosen: isParallel ? "Use parallel workers" : "Use sequential pipeline",
      worked: wasEffective,
    }],
    outcomes: { aligned: wasEffective, cost: 0.5, wallMs: (record.endedAt ?? Date.now()) - record.startedAt },
    evidence: [],
    provenance: { sourceSessions: [record.sessionId] },
    schemaVersion: "1.0",
  }] };
}
```

## Common pitfalls

1. **Postmortem doesn't get called** — Mount an ExperienceLibrary. Kernel auto-invokes postmortem only if both postmortem AND library are mounted.

2. **Experience has wrong approachFingerprint** — Use a consistent fingerprint across similar tasks. Example: "bug-fix-in-typescript", not "bug-fix-in-typescript-2024-04-17".

3. **Hints are never consumed** — Integrate with surveillance. Surveillance receives hints via `AssessmentInput.experienceHints` and uses them to calibrate probes.

4. **Experiences grow unbounded** — Implement merge logic in ExperienceLibrary. Similar experiences should be consolidated, not duplicated.

5. **Analysis is too simplistic** — Postmortem runs *after* session completion. You have full access to SessionRecord. Extract rich decision lessons, not just yes/no.

## Minimal invocation

```typescript
import type { Postmortem, SessionRecord, Experience, ExperienceId, AgentId, Result } from "@emerge/kernel/contracts";

const postmortem: Postmortem = {
  analyze: async (record: SessionRecord): Promise<Result<readonly Experience[]>> => ({
    ok: true,
    value: [{
      id: `exp-${record.sessionId}` as ExperienceId,
      taskType: "demo",
      approachFingerprint: "test",
      description: "Test experience",
      optimizedTopology: { kind: "supervisor-worker", config: { dispatch: "parallel" } },
      decisionLessons: [{ stepDescription: "worked", chosen: "yes", worked: true }],
      outcomes: { aligned: true, cost: 0, wallMs: 0 },
      evidence: [],
      provenance: { sourceSessions: [record.sessionId] },
      schemaVersion: "1.0",
    }],
  }),
};

kernel.mountPostmortem(postmortem);
// On endSession(), this runs automatically
```

## Links

- **Contracts:**
  - Postmortem: `packages/kernel/src/contracts/experience.ts` (Postmortem interface)
  - Experience: `packages/kernel/src/contracts/experience.ts` (Experience type)
  - ExperienceLibrary: `packages/kernel/src/contracts/experience.ts`
  - SessionRecord: `packages/kernel/src/contracts/replay.ts`

- **Implementations:**
  - buildPostmortem: `packages/agents/src/roles/postmortem.ts`
  - Example: `examples/topology-supervisor-worker/src/index.ts` (InMemoryExperienceLibrary)

- **ADRs:**
  - ADR 0018: Session Replay (postmortem input source)
  - ADR 0019: Experience Library and Postmortem (why separate)
  - ADR 0029: Self-improving loop (experience → surveillance hints → adaptation)

- **Roadmap:**
  - [shipped: M3c1] Auto-invoke postmortem on endSession()
  - [planned: M5] ExperienceLibrary SQLite backend (durable storage)
  - [planned: M5] Merge optimization (consolidate similar experiences)
  - [planned: M5] Experience bundles (export/import for community sharing)
