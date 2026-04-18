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

    // 1. Find what worked
    const successfulApproaches = record.events
      .filter(e => e.kind === "progress" && "step" in e && e.step?.includes("success"))
      .map(e => ({ approach: String((e as any).step), outcome: "success" }));

    // 2. Find what failed
    const failedApproaches = record.events
      .filter(e => e.kind === "verdict" && "verdict" in e && (e as any).verdict.kind !== "aligned")
      .map(e => ({ approach: String((e as any).step), outcome: "failed" }));

    // 3. Combine into Experience
    if (successfulApproaches.length > 0) {
      experiences.push({
        id: `exp-${record.sessionId}` as ExperienceId,
        approach: successfulApproaches[0].approach,
        problemSignature: "multi-agent-decomposition",
        solutions: [
          {
            decision: "Use supervisor/worker topology",
            outcome: successfulApproaches[0].outcome,
            costUsd: 5.0,  // From cost ledger
          }
        ],
        metadata: { timestamp: record.startedAt },
      });
    }

    return { ok: true, value: experiences };
  }
}
```

## SDK integration (emerge-as-client)

```typescript
import { buildPostmortem } from "@emerge/agents";
import type { SessionRecord, Experience, ExperienceId } from "@emerge/kernel/contracts";

const myPostmortem = buildPostmortem({
  analyze: async (record: SessionRecord): Promise<Experience[]> => {
    const experiences: Experience[] = [];

    // Analyze the session record
    const tokenCost = record.events
      .filter(e => e.kind === "delta" || e.kind === "result")
      .reduce((sum, e) => sum + 1, 0);  // Simplified; real: parse usage

    // Extract a lesson
    experiences.push({
      id: `exp-${record.sessionId}` as ExperienceId,
      approach: "divide-and-conquer",
      problemSignature: `task-type-${record.contractId}`,
      solutions: [
        {
          decision: "Spawn 5 parallel workers",
          outcome: "success",
          costUsd: record.costLedger?.totals.grand ?? 0,
        }
      ],
      metadata: {
        timestamp: record.startedAt,
        duration: Date.now() - record.startedAt,
        sessionId: record.sessionId,
      },
    });

    return experiences;
  },
});

const kernel = new Kernel({ ... }, {});
kernel.mountPostmortem(myPostmortem);

// Run a session
kernel.setSession(sessionId, contractId);
await kernel.spawn(agentSpec);
await kernel.runAgent(handle);

// On endSession(), postmortem is auto-invoked if ExperienceLibrary is also mounted
const endResult = await kernel.endSession();
// The experience is now stored in the library for future sessions to query
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
  problemSignature: "multi-agent-task",
  contextSummary: "Decompose large goal into sub-tasks",
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
async analyze(record: SessionRecord): Promise<Experience[]> {
  const decisions: DecisionLesson[] = record.events
    .filter(e => e.kind === "progress" && "step" in e)
    .map(e => ({
      decision: String((e as any).step),
      outcome: "success",  // or detect from verdict
    }));

  return [{
    id: `exp-${record.sessionId}`,
    approach: "supervisor-worker",
    problemSignature: record.contractId,
    solutions: decisions,
    metadata: { timestamp: Date.now() },
  }];
}
```

### Pattern 2: Cost-effectiveness analysis

```typescript
async analyze(record: SessionRecord): Promise<Experience[]> {
  const costUsd = record.events
    .filter(e => (e as any).usage?.usd)
    .reduce((sum, e) => sum + ((e as any).usage.usd ?? 0), 0);

  const duration = record.endedAt - record.startedAt;
  const costPerMinute = costUsd / (duration / 60000);

  return [{
    id: `exp-${record.sessionId}`,
    approach: "cheap-first-strong-second",
    problemSignature: record.contractId,
    solutions: [{
      decision: costPerMinute > 1.0 ? "Escalate to Sonnet" : "Use Haiku",
      outcome: "success",
      costUsd,
    }],
    metadata: { costPerMinute },
  }];
}
```

### Pattern 3: Topology effectiveness

```typescript
async analyze(record: SessionRecord): Promise<Experience[]> {
  const isParallel = record.events.filter(e => e.kind === "progress").length > 3;
  const wasEffective = record.events.some(e => e.kind === "verdict" && (e as any).verdict.kind === "aligned");

  return [{
    id: `exp-${record.sessionId}`,
    approach: isParallel ? "parallel-workers" : "sequential",
    problemSignature: record.contractId,
    solutions: [{
      decision: isParallel ? "Use parallel topology" : "Use sequential",
      outcome: wasEffective ? "success" : "retry-needed",
      costUsd: record.costLedger?.totals.grand ?? 0,
    }],
    metadata: { parallel: isParallel },
  }];
}
```

## Common pitfalls

1. **Postmortem doesn't get called** — Mount an ExperienceLibrary. Kernel auto-invokes postmortem only if both postmortem AND library are mounted.

2. **Experience has wrong problemSignature** — Use a consistent signature across similar tasks. Example: "bug-fix-in-typescript", not "bug-fix-in-typescript-2024-04-17".

3. **Hints are never consumed** — Integrate with surveillance. Surveillance receives hints via `AssessmentInput.experienceHints` and uses them to calibrate probes.

4. **Experiences grow unbounded** — Implement merge logic in ExperienceLibrary. Similar experiences should be consolidated, not duplicated.

5. **Analysis is too simplistic** — Postmortem runs *after* session completion. You have full access to SessionRecord. Extract rich decision lessons, not just yes/no.

## Minimal invocation

```typescript
const postmortem = {
  analyze: async (record: SessionRecord) => [{
    id: `exp-${record.sessionId}`,
    approach: "demo",
    problemSignature: "test",
    solutions: [{ decision: "worked", outcome: "success", costUsd: 0 }],
    metadata: { ts: Date.now() },
  }],
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
