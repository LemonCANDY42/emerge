# Custodian Agent

Hold the contract immutably, manage quota, store artifacts. Prevents contract drift as context compresses. Mediates budget allocation across a topology.

## When to use

- **Long-running session with context compression** — contract can drift if not guarded.
- **Multi-agent topology with shared budget** — custodian mediates quota requests.
- **Artifacts need provenance** — who created it, when, why.
- **Compliance / audit trail required** — every decision logged in pinned memory.

## Recommended blueprint (emerge-as-host)

```typescript
const custodianSpec: AgentSpec = {
  id: "custodian-1",
  role: "custodian",
  description: "Holds contract, manages quota, stores artifacts",

  provider: {
    kind: "static",
    providerId: "mock",  // Custodian does NOT call the model
  },

  system: {
    kind: "literal",
    text: "You are a contract guardian. Enforce the master agreement.",
  },

  toolsAllowed: [],  // No LLM-based tools; mediation only

  memoryView: {
    inheritFromSupervisor: false,
    writeTags: ["contract-pinned", "quota-ledger", "artifacts"],
    // Everything is pinned (survives compression)
  },

  budget: {
    tokensIn: 5_000,     // Just reads contract + ledger
    tokensOut: 0,        // No generation
    usd: 0.0,            // No model calls
  },

  termination: {
    maxIterations: 1,    // Minimal; handles one cycle
    maxWallMs: 1_000,    // Instant
    budget: { tokensIn: 5_000, tokensOut: 0, wallMs: 1_000 },
    retry: { transient: 0, nonRetryable: 0 },
    cycle: { windowSize: 1, repeatThreshold: 1 },
    done: {
      kind: "predicate",
      description: "Always already done",
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
import { buildCustodian } from "@emerge/agents";
import { LocalFsArtifactStore } from "@emerge/artifacts-local-fs";
import type { Contract, QuotaRequest, QuotaDecision, ContractId, AgentId } from "@emerge/kernel/contracts";

const contract: Contract = {
  id: "refactor-contract" as ContractId,
  goal: "Refactor 10,000 lines of TypeScript",
  acceptanceCriteria: [
    { kind: "predicate", description: "All tests pass" },
    { kind: "predicate", description: "No breaking changes" },
  ],
  inputs: [],
  outputs: [{ name: "refactored_code", schema: { "~standard": { version: 1, vendor: "mock", validate: (v) => ({ value: v }) } } }],
  constraints: [
    { kind: "budget", budget: { tokensIn: 500_000, tokensOut: 50_000, usd: 100.0 } },
  ],
  hash: "abc123",
};

const kernel = new Kernel(
  {
    mode: "auto",
    roles: {
      custodian: "custodian-main" as AgentId,  // Register the ID
    },
  },
  {}
);

const artifactStore = new LocalFsArtifactStore("./.emerge/artifacts");

const custodian = buildCustodian({
  id: "custodian-main" as AgentId,
  contract,
  quotaPolicy: (request: QuotaRequest): QuotaDecision => {
    // Policy: grant up to 80% of the requested amount
    const grant: QuotaDecision = {
      kind: "grant",
      granted: {
        tokensIn: Math.floor((request.ask.tokensIn ?? 0) * 0.8),
        tokensOut: Math.floor((request.ask.tokensOut ?? 0) * 0.8),
        usd: ((request.ask.usd ?? 0) * 0.8),
      },
      rationale: "Grant 80% of requested per agent",
    };
    return grant;
  },
  artifactStore,
  memory: kernel.getMemory(),  // Pinned items survive compression
});

// Spawn the custodian (no runAgent; it's not a loop)
const custodianHandle = await kernel.spawn(custodian.spec);
if (!custodianHandle.ok) {
  console.error("Spawn custodian failed:", custodianHandle.error);
  process.exit(1);
}

// Now spawn producers; they can send quota.request
// kernel routes quota.request to the custodian
// custodian applies the policy + emits quota.grant/quota.deny/quota.partial
```

## Quota policy callback

**Files:** `packages/kernel/src/contracts/quota.ts` (lines 10–30)

The core of custodian behavior:

```typescript
type QuotaPolicy = (req: QuotaRequest) => QuotaDecision | Promise<QuotaDecision>;

interface QuotaRequest {
  readonly correlationId: CorrelationId;
  readonly from: AgentId;
  readonly ask: Partial<Budget>;  // What the agent is asking for
  readonly rationale: string;      // Why they need it
  readonly evidence?: readonly ArtifactHandle[];
  readonly willTradeFor?: {
    readonly tier?: "draft" | "standard";
    readonly maxIterationsCut?: number;
  };
}

type QuotaDecision =
  | { readonly kind: "grant"; readonly granted: Partial<Budget>; readonly rationale: string }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "partial"; readonly granted: Partial<Budget>; readonly rationale: string };
```

### Policy examples

**Example 1: grant all requests (demo)**
```typescript
quotaPolicy: (req: QuotaRequest): QuotaDecision => ({
  kind: "grant",
  granted: req.ask,
  rationale: "Unlimited (demo)"
})
```

**Example 2: deny and suggest tier down**
```typescript
quotaPolicy: (req: QuotaRequest): QuotaDecision => {
  if ((req.ask.tokensOut ?? 0) > 10_000) {
    return {
      kind: "partial",
      granted: { tokensOut: 10_000 },
      rationale: "Capped to 10k tokens; can trade for draft tier",
    };
  }
  return { kind: "grant", granted: req.ask, rationale: "Within limit" };
}
```

**Example 3: prioritize by agent role**
```typescript
quotaPolicy: (req: QuotaRequest): QuotaDecision => {
  if (req.from === "code-agent" as AgentId) {
    return { kind: "grant", granted: req.ask, rationale: "Code agent is priority" };
  } else if (req.from === "critic" as AgentId) {
    return { kind: "grant", granted: { tokensIn: 5_000, tokensOut: 500 }, rationale: "Critic is minimal" };
  } else {
    return {
      kind: "grant",
      granted: { tokensIn: req.ask.tokensIn, tokensOut: (req.ask.tokensOut ?? 0) * 0.5 },
      rationale: "Standard 50% policy",
    };
  }
}
```

## Recommended config defaults

| Field | Value | Why |
|---|---|---|
| `provider` | mock | No model calls |
| `toolsAllowed` | none | Mediation only |
| `maxIterations` | 0 | No loop |
| `maxWallMs` | 1000 | Instant |
| `budget` | minimal | No model calls |
| `acl` | "any" | All agents can send quota.request |
| `surveillance` | "off" | Fixed behavior |

## Common pitfalls

1. **Custodian registered but quota.request not routed** — Ensure KernelConfig.roles.custodian is set to custodian.spec. Kernel automatically routes quota.* to this agent.

2. **Policy grants unlimited budget** — This defeats the purpose. Set realistic limits. Example: `remaining.tokensIn * 0.5` grants 50% of what's left.

3. **Contract mutated mid-session** — Custodian holds the contract immutably (frozen object). To change contract, spawn a new session.

4. **Pinned memory is empty** — Call `custodian.instance.pin()` to add items. Or pass a shared Memory reference via `buildCustodian({ memory: kernel.getMemory() })`.

5. **Artifact store not wired** — Pass an ArtifactStore (e.g., LocalFsArtifactStore) to buildCustodian. Otherwise artifacts are lost.

## Minimal invocation

```typescript
import type { ContractId, AgentId } from "@emerge/kernel/contracts";

const custodian = buildCustodian({
  id: "custodian" as AgentId,
  contract: {
    id: "minimal-contract" as ContractId,
    goal: "My task",
    acceptanceCriteria: [{ kind: "predicate", description: "Done" }],
    inputs: [],
    outputs: [],
    constraints: [],
    hash: "123",
  },
  quotaPolicy: (req) => ({ kind: "grant", granted: req.ask, rationale: "OK" }),
});

const result = await kernel.spawn(custodian.spec);
if (!result.ok) {
  console.error("Spawn failed:", result.error);
}
```

## Links

- **Contracts:**
  - Quota: `packages/kernel/src/contracts/quota.ts` (lines 10–30)
  - Contract: `packages/kernel/src/contracts/contract.ts` (lines 9–18)

- **Implementations:**
  - buildCustodian: `packages/agents/src/roles/custodian.ts`
  - Example: `examples/topology-supervisor-worker/src/index.ts`

- **ADRs:**
  - ADR 0011: Contract Custodian (why separate from producer)
  - ADR 0013: Quota protocol (how quota flows)
  - ADR 0016: Pinned context (how contract survives compression)

- **Roadmap:**
  - [planned: M5] LLM-driven quota policy (agent negotiates budget)
  - [planned: M5] Experience-driven policy (learn optimal allocation from past sessions)
