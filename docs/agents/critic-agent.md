# Critic Agent (Adjudicator)

Evaluate outputs against acceptance criteria and gate completion. Prevents the producer from self-marking "done" when it actually fails. The separate judge pattern.

## When to use

- **Self-grading bias risk** — producer is the worst judge of its own work.
- **Acceptance criteria are clear** — essay ≥1500 words, code passes tests, API ≤100ms.
- **High-stakes work** — contract fulfillment, compliance, quality gates.
- **Multi-step task with pivots** — adjudicator can trigger retry, escalate, or surface to human.

## Recommended blueprint (emerge-as-host)

```typescript
const criticSpec: AgentSpec = {
  id: "critic-1",
  role: "adjudicator",
  description: "Evaluates outputs against acceptance criteria",

  provider: {
    kind: "static",
    providerId: "mock",  // Adjudicator does NOT call the model (in M3a)
  },

  system: {
    kind: "literal",
    text: "You are a compliance reviewer. Evaluate outputs against the contract.",
  },

  toolsAllowed: [],  // No tools in M3a; reads contract + output only

  memoryView: {
    inheritFromSupervisor: true,
    writeTags: ["verdicts"],
    readFilter: { domain: "contract" },
  },

  budget: {
    tokensIn: 10_000,    // Just reads contract + output
    tokensOut: 500,      // Verdict text only
    usd: 0.0,            // No model calls
  },

  termination: {
    maxIterations: 1,    // One evaluation, done
    maxWallMs: 10_000,   // Quick evaluation
    budget: { tokensIn: 10_000, tokensOut: 500 },
    retry: { transient: 0, nonRetryable: 0 },
    cycle: { windowSize: 1, repeatThreshold: 1 },
    done: {
      kind: "predicate",
      description: "Verdict emitted",
    }
  },

  acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
  capabilities: { tools: [], modalities: ["text"], qualityTier: "standard", streaming: false, interrupts: false, maxConcurrency: 1 },
  lineage: { depth: 0 },

  surveillance: "off",
};
```

## SDK integration (emerge-as-client)

```typescript
import { buildAdjudicator } from "@emerge/agents";
import type { EvaluationInput, Verdict, Contract } from "@emerge/kernel/contracts";

const contract: Contract = {
  goal: "Write a 3-page essay on climate policy",
  acceptanceCriteria: "≥2000 words, ≥3 cited sources, clear thesis",
  // ... more fields
};

const adjudicator = buildAdjudicator({
  id: "critic-1",
  contract,
  evaluate: (input: EvaluationInput): Verdict => {
    const output = typeof input.output === "string" ? input.output : JSON.stringify(input.output);
    const wordCount = output.split(/\s+/).length;

    if (wordCount < 2000) {
      return {
        kind: "off-track",
        reasoning: `Only ${wordCount} words; need ≥2000`,
      };
    }

    const hasCitations = /\[[\d]+\]|cite|source|reference/.test(output.toLowerCase());
    if (!hasCitations) {
      return {
        kind: "off-track",
        reasoning: "No citations found",
      };
    }

    return {
      kind: "aligned",
      reasoning: `Output meets criteria: ${wordCount} words, citations present`,
    };
  },
  resultSenders: ["essay-writer"],  // Watch these agents' results
});

const kernel = new Kernel(
  {
    mode: "auto",
    roles: { adjudicator: adjudicator.spec },  // Register
  },
  {}
);

// Mount producer + adjudicator
await kernel.spawn(producerSpec);
await kernel.spawn(adjudicator.spec);

// Subscribe to verdicts
const bus = kernel.getBus();
bus.subscribe(
  { kind: "agent", id: "critic-1" },
  async (envelope) => {
    if (envelope.kind === "verdict") {
      console.log(`Verdict: ${envelope.verdict.kind} — ${envelope.verdict.reasoning}`);
    }
  }
);

// Run the producer
await kernel.runAgent(producerHandle);

// End session: kernel waits for "aligned" verdict before marking complete
const endResult = await kernel.endSession();
if (endResult.ok && endResult.value.verdict?.kind === "aligned") {
  console.log("Session accepted");
} else {
  console.log("Session rejected or retry needed");
}
```

## Recommended config defaults

| Field | Value | Why |
|---|---|---|
| `provider` | mock | No model calls in M3a |
| `toolsAllowed` | none | Read-only; no side effects |
| `maxIterations` | 1 | One evaluation, done |
| `maxWallMs` | 10_000 | Quick; no wait |
| `budget` | minimal | No model calls |
| `acl.acceptsRequests` | restricted to producer | Only the producer is evaluated |
| `surveillance` | "off" | Fixed behavior |

## Verdict kinds

```typescript
type Verdict =
  | { kind: "aligned"; reasoning: string }
  | { kind: "partial"; reasoning: string; remediation?: string }
  | { kind: "off-track"; reasoning: string; remediation?: string }
  | { kind: "failed"; reasoning: string };
```

- **aligned**: output meets all acceptance criteria. Session completes.
- **partial**: mostly OK, but missing some criteria. Kernel may retry or surface to human (depends on policy).
- **off-track**: significant gaps. Kernel retries or escalates.
- **failed**: unacceptable. Kernel halts unless in "trust mode".

## Common patterns

### Pattern 1: Simple yes/no evaluation

```typescript
evaluate: (input) => {
  const passed = input.output === "expected-value";
  return passed
    ? { kind: "aligned", reasoning: "Matches expected output" }
    : { kind: "failed", reasoning: "Mismatch" };
}
```

### Pattern 2: Word count + citation check

```typescript
evaluate: (input) => {
  const output = String(input.output);
  const words = output.split(/\s+/).length;
  const citations = (output.match(/\[\d+\]/g) || []).length;

  if (words < 1500) return { kind: "off-track", reasoning: `${words} words < 1500` };
  if (citations < 3) return { kind: "partial", reasoning: `${citations} citations < 3` };
  return { kind: "aligned", reasoning: "Meets all criteria" };
}
```

### Pattern 3: Test suite pass/fail

```typescript
evaluate: async (input) => {
  const testResult = input.metadata?.testOutput;
  if (!testResult) return { kind: "off-track", reasoning: "No test results" };
  if (testResult.exitCode === 0) {
    return { kind: "aligned", reasoning: "All tests pass" };
  } else {
    return { kind: "failed", reasoning: `Tests failed: ${testResult.stderr}` };
  }
}
```

## Common pitfalls

1. **Adjudicator never called** — Register its spec in KernelConfig.roles or explicitly spawn it. The kernel needs to know where to emit verdicts.

2. **Verdict ignored, producer continues** — Set trustMode: false (default). Kernel waits for "aligned" verdict before endSession() completes.

3. **Evaluation logic is subjective** — Acceptance criteria must be measurable. "Good writing" is not testable. "≥1500 words + ≥3 sources + no grammatical errors" is.

4. **Too strict; legitimate work rejected** — Use "partial" verdict for minor gaps, not "failed". Adjust thresholds per task.

5. **Adjudicator crashes; no fallback** — Provide a default verdict in the catch block. Or use trustMode: implicit if evaluation is optional.

## Minimal invocation

```typescript
const adj = buildAdjudicator({
  id: "critic",
  contract: { goal: "Write an essay", acceptanceCriteria: "≥500 words" },
  evaluate: (input) => {
    const len = String(input.output).length;
    return len >= 500
      ? { kind: "aligned", reasoning: "Long enough" }
      : { kind: "off-track", reasoning: `Only ${len} chars` };
  },
});

await kernel.spawn(adj.spec);
```

## Links

- **Contracts:**
  - Adjudicator: `packages/kernel/src/contracts/adjudicator.ts`
  - Verdict: `packages/kernel/src/contracts/adjudicator.ts`
  - Bus: `packages/kernel/src/contracts/bus.ts` (verdict envelope)

- **Implementations:**
  - buildAdjudicator: `packages/agents/src/roles/adjudicator.ts`
  - Example: `examples/topology-supervisor-worker/src/index.ts`

- **ADRs:**
  - ADR 0012: Compliance Adjudicator (why separate from producer)

- **Roadmap:**
  - [planned: M4] LLM-driven adjudicator (evaluate via agent, not just JS)
