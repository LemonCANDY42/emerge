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
    maxIterations: 0,    // No loop; mediates only
    maxWallMs: 1_000,    // Instant
    budget: { tokensIn: 5_000, tokensOut: 0 },
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
import type { Contract, QuotaRequest, QuotaDecision } from "@emerge/kernel/contracts";

const contract: Contract = {
  goal: "Refactor 10,000 lines of TypeScript",
  acceptanceCriteria: "All tests pass, no breaking changes",
  budget: { tokensIn: 500_000, tokensOut: 50_000, usd: 100.0 },
  startedAt: Date.now(),
};

const artifactStore = new LocalFsArtifactStore("./.emerge/artifacts");

const custodian = buildCustodian({
  id: "custodian-main",
  contract,
  quotaPolicy: (request: QuotaRequest): QuotaDecision => {
    // Policy: grant up to 80% of remaining budget per sub-agent
    const remaining = {
      tokensIn: contract.budget.tokensIn - request.spentIn,
      tokensOut: contract.budget.tokensOut - request.spentOut,
      usd: contract.budget.usd - request.spentUsd,
    };

    return {
      granted: {
        tokensIn: Math.floor(remaining.tokensIn * 0.8),
        tokensOut: Math.floor(remaining.tokensOut * 0.8),
        usd: remaining.usd * 0.8,
      },
      rationale: "Grant 80% of remaining per agent",
    };
  },
  artifactStore,
  memory: kernel.getMemory(),  // Pinned items survive compression
});

const kernel = new Kernel(
  {
    mode: "auto",
    roles: {
      custodian: custodian.spec,  // Register
    },
  },
  {}
);

// Mount the custodian (no runAgent; it's not a loop)
await kernel.spawn(custodian.spec);

// Now spawn producers; they can send quota.request
// kernel routes quota.* envelopes to the custodian
// custodian applies the policy + emits quota.decision

// At endSession(), check the custodian's ledger:
const ledger = custodian.instance.ledger();
console.log("Quota decisions made:", ledger.decisions.length);
console.log("Total granted:", ledger.total.granted);
```

## Quota policy callback

The core of custodian behavior:

```typescript
type QuotaPolicy = (req: QuotaRequest) => QuotaDecision | Promise<QuotaDecision>;

interface QuotaRequest {
  agentId: AgentId;
  requested: Budget;
  spentIn: number;   // Tokens already spent
  spentOut: number;
  spentUsd: number;
  context?: string;  // "I need this for [reason]"
}

interface QuotaDecision {
  granted: Budget;
  rationale: string;
  deferred?: boolean;  // Ask again later
}
```

### Policy examples

**Example 1: grant all requests (demo)**
```typescript
quotaPolicy: (req) => ({ granted: req.requested, rationale: "Unlimited" })
```

**Example 2: proportional to remaining**
```typescript
quotaPolicy: (req) => {
  const totalBudget = contract.budget;
  const remaining = { /* calculate */ };
  const proportion = Math.min(1.0, remaining / totalBudget);
  return {
    granted: {
      tokensIn: Math.floor(req.requested.tokensIn * proportion),
      tokensOut: Math.floor(req.requested.tokensOut * proportion),
      usd: req.requested.usd * proportion,
    },
    rationale: `Grant ${(proportion * 100).toFixed(0)}% of request`,
  };
}
```

**Example 3: prioritize by role**
```typescript
quotaPolicy: (req) => {
  if (req.agentId === "code-agent") {
    return { granted: req.requested, rationale: "Code agent is priority" };
  } else if (req.agentId === "critic") {
    return { granted: { tokensIn: 5_000, tokensOut: 500, usd: 0.01 }, rationale: "Critic gets minimum" };
  } else {
    return { granted: { ...req.requested, usd: req.requested.usd * 0.5 }, rationale: "Standard 50%" };
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
const custodian = buildCustodian({
  id: "custodian",
  contract: { goal: "My task", acceptanceCriteria: "Done" },
  quotaPolicy: (req) => ({ granted: req.requested, rationale: "OK" }),
});

await kernel.spawn(custodian.spec);
```

## Links

- **Contracts:**
  - Custodian: `packages/kernel/src/contracts/custodian.ts`
  - Quota: `packages/kernel/src/contracts/quota.ts`
  - Contract: `packages/kernel/src/contracts/common.ts` (Contract type)

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
