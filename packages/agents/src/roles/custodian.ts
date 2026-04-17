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

export type QuotaPolicy = (req: QuotaRequest) => QuotaDecision | Promise<QuotaDecision>;

export interface BuildCustodianOptions {
  readonly id: AgentId;
  readonly contract: Contract;
  readonly quotaPolicy: QuotaPolicy;
  readonly artifactStore?: ArtifactStore;
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
}

class InProcessCustodian implements Custodian {
  private readonly _contract: Contract;
  private readonly _quotaPolicy: QuotaPolicy;
  private readonly _store: ArtifactStore | undefined;
  private readonly _pins = new Map<string, MemoryItem>();
  private readonly _ledgerEntries: QuotaLedgerEntry[] = [];

  constructor(opts: BuildCustodianOptions) {
    this._contract = opts.contract;
    this._quotaPolicy = opts.quotaPolicy;
    this._store = opts.artifactStore;
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
    const decision = await this._quotaPolicy(req);
    this._ledgerEntries.push({ at: Date.now(), request: req, decision });
    return decision;
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
    this._pins.set(`${scope}:${item.id}`, { ...item, pin: scope });
  }

  pins(scope?: PinScope): readonly MemoryItem[] {
    const all = [...this._pins.values()];
    if (scope === undefined) return all;
    return all.filter((i) => i.pin === scope);
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

  // Pin the contract into the custodian's own memory (represented via the
  // instance.pin() call below — the kernel's SimpleMemory is separate; this is
  // the Custodian's own pinned tier as per ADR 0016)
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

  return { spec, instance };
}
