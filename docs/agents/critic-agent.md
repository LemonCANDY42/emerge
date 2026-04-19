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
import { buildAdjudicator } from "@lwrf42/emerge-agents";
import type { EvaluationInput, Verdict, Contract } from "@lwrf42/emerge-kernel/contracts";

const contract: Contract = {
  id: "essay-contract" as ContractId,
  goal: "Write a 3-page essay on climate policy",
  acceptanceCriteria: [
    { kind: "predicate", description: "≥2000 words" },
    { kind: "predicate", description: "≥3 cited sources" },
    { kind: "predicate", description: "Clear thesis" },
  ],
  inputs: [],
  outputs: [{ name: "essay", schema: { "~standard": { version: 1, vendor: "mock", validate: (v) => ({ value: v }) } } }],
  constraints: [],
  hash: "abc123",
};

const adjudicator = buildAdjudicator({
  id: "critic-1" as AgentId,
  contract,
  evaluate: (input: EvaluationInput): Verdict => {
    const output = typeof input.outputs.essay === "string" ? input.outputs.essay : JSON.stringify(input.outputs.essay);
    const wordCount = output.split(/\s+/).length;

    if (wordCount < 2000) {
      return {
        kind: "off-track",
        reason: `Only ${wordCount} words; need ≥2000`,
        suggestion: "Expand the essay to at least 2000 words",
      };
    }

    const hasCitations = /\[[\d]+\]|cite|source|reference/.test(output.toLowerCase());
    if (!hasCitations) {
      return {
        kind: "off-track",
        reason: "No citations found",
        suggestion: "Add citations from credible sources",
      };
    }

    return {
      kind: "aligned",
      rationale: `Output meets criteria: ${wordCount} words, citations present`,
      evidence: input.artifacts,
    };
  },
});

const kernel = new Kernel(
  {
    mode: "auto",
    roles: { adjudicator: "critic-1" as AgentId },  // Register the adjudicator ID
  },
  {}
);

// Mount producer + adjudicator
const producerHandle = await kernel.spawn(producerSpec);
if (!producerHandle.ok) {
  console.error("Spawn producer failed:", producerHandle.error);
  process.exit(1);
}

const adjHandle = await kernel.spawn(adjudicator.spec);
if (!adjHandle.ok) {
  console.error("Spawn adjudicator failed:", adjHandle.error);
  process.exit(1);
}

// Subscribe to verdicts
const bus = kernel.getBus();
const verdictSub = bus.subscribe(
  "critic-1" as AgentId,
  { kind: "from", sender: "critic-1" as AgentId, kinds: ["verdict"] }
);

const verdictTask = (async () => {
  for await (const envelope of verdictSub.events) {
    if (envelope.kind === "verdict") {
      console.log(`Verdict: ${envelope.verdict.kind}`);
      if (envelope.verdict.kind === "off-track") {
        console.log(`Reason: ${(envelope.verdict as any).reason}`);
      }
    }
  }
})();

// Run the producer
await kernel.runAgent(producerHandle.value);

// End session: kernel waits for "aligned" verdict before marking complete
const endResult = await kernel.endSession();
if (endResult.ok) {
  console.log("Session ended");
  verdictSub.close();
} else {
  console.error("Session end failed:", endResult.error);
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

**File:** `packages/kernel/src/contracts/adjudicator.ts` (lines 25–37)

```typescript
type Verdict =
  | { kind: "aligned"; rationale: string; evidence: readonly ArtifactHandle[] }
  | { kind: "partial"; missing: readonly AcceptanceCriterion[]; suggestion: string }
  | { kind: "off-track"; reason: string; suggestion: string }
  | { kind: "failed"; reason: string };
```

- **aligned**: output meets all acceptance criteria. Session completes.
- **partial**: mostly OK, but missing some criteria. List the missing criteria and suggest how to address them.
- **off-track**: significant gaps. Provide reason and actionable suggestion.
- **failed**: unacceptable. Kernel halts unless trustMode is set.

## Common patterns

### Pattern 1: Simple yes/no evaluation

```typescript
evaluate: (input: EvaluationInput): Verdict => {
  const passed = input.outputs.result === "expected-value";
  return passed
    ? { kind: "aligned", rationale: "Matches expected output", evidence: input.artifacts }
    : { kind: "failed", reason: "Output does not match expected value" };
}
```

### Pattern 2: Word count + citation check

```typescript
evaluate: (input: EvaluationInput): Verdict => {
  const output = String(input.outputs.essay || "");
  const words = output.split(/\s+/).length;
  const citations = (output.match(/\[\d+\]/g) || []).length;

  if (words < 1500) {
    return { kind: "off-track", reason: `${words} words < 1500`, suggestion: "Expand to at least 1500 words" };
  }
  if (citations < 3) {
    return { kind: "partial", missing: [], suggestion: `Only ${citations} citations; need ≥3` };
  }
  return { kind: "aligned", rationale: "Meets all criteria", evidence: input.artifacts };
}
```

### Pattern 3: Test suite pass/fail

```typescript
evaluate: async (input: EvaluationInput): Promise<Verdict> => {
  // Look for test output in the results
  const testOutput = input.outputs.testOutput;
  if (!testOutput) {
    return { kind: "off-track", reason: "No test results produced", suggestion: "Run the test suite first" };
  }
  const result = typeof testOutput === "string" ? JSON.parse(testOutput) : testOutput;
  if (result.exitCode === 0) {
    return { kind: "aligned", rationale: "All tests pass", evidence: input.artifacts };
  } else {
    return { kind: "failed", reason: `Tests failed with exit code ${result.exitCode}` };
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
import type { ContractId, AgentId } from "@lwrf42/emerge-kernel/contracts";

const adj = buildAdjudicator({
  id: "critic" as AgentId,
  contract: {
    id: "test-contract" as ContractId,
    goal: "Write an essay",
    acceptanceCriteria: [{ kind: "predicate", description: "≥500 words" }],
    inputs: [],
    outputs: [{ name: "essay", schema: { "~standard": { version: 1, vendor: "mock", validate: (v) => ({ value: v }) } } }],
    constraints: [],
    hash: "123",
  },
  evaluate: (input) => {
    const len = String(input.outputs.essay || "").length;
    return len >= 500
      ? { kind: "aligned", rationale: "Long enough", evidence: input.artifacts }
      : { kind: "off-track", reason: `Only ${len} chars`, suggestion: "Write more" };
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
