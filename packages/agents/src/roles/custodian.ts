/**
 * buildCustodian — constructs an in-process Custodian instance + its AgentSpec.
 *
 * The Custodian:
 *   - holds the Contract immutably
 *   - mediates quota via a quotaPolicy callback
 *   - stores pinned MemoryItems in-process (M4: durable storage)
 *   - delegates artifact storage to a provided ArtifactStore
 *   - maintains an in-process ledger of quota decisions
 *   - returns a topology snapshot (basic implementation; no live delta stream)
 *
 * The kernel routes quota.request envelopes to this Custodian's id when it is
 * registered in KernelConfig.roles.custodian.
 */

import type {
  AgentId,
  AgentSpec,
  Artifact,
  ArtifactHandle,
  ArtifactInput,
  ArtifactStore,
  Budget,
  Contract,
  Custodian,
  Memory,
  MemoryItem,
  PinScope,
  QuotaDecision,
  QuotaLedger,
  QuotaLedgerEntry,
  QuotaRequest,
  TimeWindow,
  TopologyDelta,
  TopologySnapshot,
} from "@emerge/kernel/contracts";

/**
 * M1: Recursively freeze an object so contract() always returns an immutable value.
 */
function deepFreeze<T>(o: T): T {
  Object.freeze(o);
  if (typeof o === "object" && o !== null) {
    for (const key of Object.keys(o)) {
      const val = (o as Record<string, unknown>)[key];
      if (typeof val === "object" && val !== null && !Object.isFrozen(val)) {
        deepFreeze(val);
      }
    }
  }
  return o;
}

export type QuotaPolicy = (req: QuotaRequest) => QuotaDecision | Promise<QuotaDecision>;

export interface BuildCustodianOptions {
  readonly id: AgentId;
  readonly contract: Contract;
  readonly quotaPolicy: QuotaPolicy;
  readonly artifactStore?: ArtifactStore;
  /**
   * C2: Shared kernel Memory reference. When provided, pin() writes into this
   * shared memory so pinned items survive scope/agent filtering (ADR 0016).
   */
  readonly memory?: Memory;
  /**
   * M7: Per-agent cumulative budget ceiling. If set, quota grants are clamped
   * to min(policyResult.granted, ceiling - currentSpend) per dimension.
   * Default: 2× the requesting agent's original spec.budget (applied ad-hoc
   * using the policy result alone when original budget is unknown).
   */
  readonly budgetCeiling?: Budget;
  /**
   * Provider id to assign to the custodian's spec. The custodian never makes
   * real LLM calls, but the kernel requires a mounted provider at spawn time.
   * Pass the id of any mock/stub provider that is mounted on the kernel.
   */
  readonly providerId?: string;
}

export interface CustodianBuild {
  readonly spec: AgentSpec;
  readonly instance: Custodian;
  /**
   * C2: Wire the shared kernel Memory after kernel construction.
   * The contract pin is re-written into the shared memory immediately.
   * Call this before the session starts so the pin is present for recall.
   */
  setMemory(memory: Memory): Promise<void>;
}

class InProcessCustodian implements Custodian {
  private readonly _contract: Contract;
  private readonly _quotaPolicy: QuotaPolicy;
  private readonly _store: ArtifactStore | undefined;
  private _memory: Memory | undefined;
  private readonly _budgetCeiling: Budget | undefined;
  private readonly _pins = new Map<string, MemoryItem>();
  private readonly _ledgerEntries: QuotaLedgerEntry[] = [];
  /** M7: cumulative quota granted per agent per dimension. */
  private readonly _agentGrantLedger = new Map<
    string,
    { tokensIn: number; tokensOut: number; wallMs: number; usd: number }
  >();
  private readonly _custodianId: AgentId;

  constructor(opts: BuildCustodianOptions) {
    // M1: deep-freeze so contract() is always immutable
    this._contract = deepFreeze(opts.contract);
    this._quotaPolicy = opts.quotaPolicy;
    this._store = opts.artifactStore;
    this._memory = opts.memory;
    this._budgetCeiling = opts.budgetCeiling;
    this._custodianId = opts.id;
  }

  contract(): Contract {
    return this._contract;
  }

  topologySnapshot(): TopologySnapshot {
    // M3a: minimal snapshot — no live topology tracking yet (M4)
    return {
      at: Date.now(),
      topology: {
        spec: { kind: "supervisor-worker", config: {} },
        members: [],
        edges: [],
      },
    };
  }

  topologyHistory(_window: TimeWindow): readonly TopologyDelta[] {
    // M3a: no history yet
    return [];
  }

  resourceLedger(): QuotaLedger {
    return { entries: this._ledgerEntries };
  }

  async receiveQuotaRequest(req: QuotaRequest): Promise<QuotaDecision> {
    const raw = await this._quotaPolicy(req);
    const decision = this._applyBudgetCeiling(req.from, raw);
    this._ledgerEntries.push({ at: Date.now(), request: req, decision });
    return decision;
  }

  /**
   * M7: Clamp a quota decision against the per-agent cumulative ceiling.
   * If any dimension is clamped, the decision becomes `partial` (not deny).
   */
  private _applyBudgetCeiling(from: AgentId, decision: QuotaDecision): QuotaDecision {
    if (decision.kind === "deny") return decision;
    if (!this._budgetCeiling) {
      // No global ceiling; track cumulative spend anyway for future ceilings.
      this._accrue(from, decision.granted);
      return decision;
    }

    const spent = this._agentGrantLedger.get(String(from)) ?? {
      tokensIn: 0,
      tokensOut: 0,
      wallMs: 0,
      usd: 0,
    };

    const clamp = (requested: number | undefined, dim: keyof typeof spent): number | undefined => {
      if (requested === undefined) return undefined;
      const ceiling = (this._budgetCeiling as Record<string, number | undefined>)[dim];
      if (ceiling === undefined) return requested;
      const remaining = Math.max(0, ceiling - spent[dim]);
      return Math.min(requested, remaining);
    };

    // clamp() always returns a number when called with a defined `requested` value.
    const clampN = (requested: number, dim: keyof typeof spent): number =>
      clamp(requested, dim) ?? requested;

    const clamped: import("@emerge/kernel/contracts").Budget = {
      ...(decision.granted.tokensIn !== undefined
        ? { tokensIn: clampN(decision.granted.tokensIn, "tokensIn") }
        : {}),
      ...(decision.granted.tokensOut !== undefined
        ? { tokensOut: clampN(decision.granted.tokensOut, "tokensOut") }
        : {}),
      ...(decision.granted.wallMs !== undefined
        ? { wallMs: clampN(decision.granted.wallMs, "wallMs") }
        : {}),
      ...(decision.granted.usd !== undefined ? { usd: clampN(decision.granted.usd, "usd") } : {}),
    };

    this._accrue(from, clamped);

    // If any dimension was clamped, downgrade to partial with a rationale.
    const wasClamped =
      (decision.granted.tokensIn !== undefined && clamped.tokensIn !== decision.granted.tokensIn) ||
      (decision.granted.tokensOut !== undefined &&
        clamped.tokensOut !== decision.granted.tokensOut) ||
      (decision.granted.wallMs !== undefined && clamped.wallMs !== decision.granted.wallMs) ||
      (decision.granted.usd !== undefined && clamped.usd !== decision.granted.usd);

    if (!wasClamped) return decision;

    return {
      kind: "partial",
      granted: clamped,
      rationale: `${decision.kind === "partial" ? `${decision.rationale} ` : ""}[ceiling reached — grant clamped]`,
    };
  }

  private _accrue(from: AgentId, granted: import("@emerge/kernel/contracts").Budget): void {
    const key = String(from);
    const cur = this._agentGrantLedger.get(key) ?? { tokensIn: 0, tokensOut: 0, wallMs: 0, usd: 0 };
    this._agentGrantLedger.set(key, {
      tokensIn: cur.tokensIn + (granted.tokensIn ?? 0),
      tokensOut: cur.tokensOut + (granted.tokensOut ?? 0),
      wallMs: cur.wallMs + (granted.wallMs ?? 0),
      usd: cur.usd + (granted.usd ?? 0),
    });
  }

  async putArtifact(input: ArtifactInput): Promise<ArtifactHandle> {
    if (!this._store) {
      throw new Error("Custodian: no ArtifactStore mounted");
    }
    const result = await this._store.put(input);
    if (!result.ok) throw new Error(`Custodian.putArtifact failed: ${result.error.message}`);
    return result.value.handle;
  }

  async getArtifact(handle: ArtifactHandle): Promise<Artifact> {
    if (!this._store) {
      throw new Error("Custodian: no ArtifactStore mounted");
    }
    const result = await this._store.get(handle);
    if (!result.ok) throw new Error(`Custodian.getArtifact failed: ${result.error.message}`);
    return result.value;
  }

  async pin(item: MemoryItem, scope: PinScope): Promise<void> {
    const pinned: MemoryItem = { ...item, pin: scope };
    this._pins.set(`${scope}:${item.id}`, pinned);

    // C2: also write into the shared kernel Memory so the pin survives
    // scope/agent filtering — pinned items bypass scope.agents filter by design (ADR 0016).
    if (this._memory) {
      await this._memory.append([
        {
          tier: pinned.tier,
          content: pinned.content,
          attributes: {
            ...pinned.attributes,
            agent: String(this._custodianId),
            pinScope: String(scope),
          },
          ...(pinned.links !== undefined ? { links: pinned.links } : {}),
          ...(pinned.tokens !== undefined ? { tokens: pinned.tokens } : {}),
          pin: scope,
        },
      ]);
    }
  }

  pins(scope?: PinScope): readonly MemoryItem[] {
    const all = [...this._pins.values()];
    if (scope === undefined) return all;
    return all.filter((i) => i.pin === scope);
  }

  /**
   * C2: Set the shared kernel Memory after construction.
   * All existing pins are immediately written into the shared memory.
   */
  async setMemory(memory: Memory): Promise<void> {
    this._memory = memory;
    // Re-write all existing local pins into the shared memory
    for (const pinned of this._pins.values()) {
      const pinScope = pinned.pin;
      await memory.append([
        {
          tier: pinned.tier,
          content: pinned.content,
          attributes: {
            ...pinned.attributes,
            agent: String(this._custodianId),
            pinScope: String(pinScope ?? "unknown"),
          },
          ...(pinned.links !== undefined ? { links: pinned.links } : {}),
          ...(pinned.tokens !== undefined ? { tokens: pinned.tokens } : {}),
          // Only spread pin if it's defined — exactOptionalPropertyTypes requires this
          ...(pinScope !== undefined ? { pin: pinScope } : {}),
        },
      ]);
    }
  }
}

/**
 * Build a standard Custodian spec + instance.
 *
 * The returned `spec` should be passed to `kernel.spawn()` so the Custodian
 * has a bus presence (handshake envelope). Its id must then be set in
 * `KernelConfig.roles.custodian` so the quota router auto-routes to it.
 */
export function buildCustodian(opts: BuildCustodianOptions): CustodianBuild {
  const instance = new InProcessCustodian(opts);

  // Pin the contract into the Custodian's own pinned tier (local cache).
  // C2: if opts.memory is provided, pin() also writes into the shared kernel Memory.
  void instance.pin(
    {
      id: `pin-contract-${opts.contract.id}`,
      tier: "working",
      content: JSON.stringify(opts.contract),
      attributes: { type: "contract", contractId: opts.contract.id },
      createdAt: Date.now(),
      pin: "contract",
    },
    "contract",
  );

  // Build a minimal budget: custodians don't execute LLM tasks themselves
  const budget: Budget = { tokensIn: 1_000, tokensOut: 500, wallMs: 30_000, usd: 0.1 };

  const spec: AgentSpec = {
    id: opts.id,
    role: "custodian",
    description: `Contract custodian for contract ${opts.contract.id}`,
    provider: opts.providerId
      ? { kind: "static", providerId: opts.providerId }
      : { kind: "router", preference: [] },
    system: {
      kind: "literal",
      text: `You are the Contract Custodian. You hold the contract immutably and mediate quota requests. Contract: ${JSON.stringify(opts.contract)}`,
    },
    toolsAllowed: [],
    memoryView: {
      inheritFromSupervisor: false,
      writeTags: ["custodian"],
      readFilter: { type: "contract" },
    },
    budget,
    termination: {
      maxIterations: 1,
      maxWallMs: 30_000,
      budget,
      retry: { transient: 0, nonRetryable: 0 },
      cycle: { windowSize: 3, repeatThreshold: 3 },
      done: { kind: "predicate", description: "Custodian does not iterate" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: [],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: false,
      interrupts: false,
      maxConcurrency: 4,
    },
    lineage: { depth: 0 },
  };

  return {
    spec,
    instance,
    setMemory: (memory: Memory) => instance.setMemory(memory),
  };
}
