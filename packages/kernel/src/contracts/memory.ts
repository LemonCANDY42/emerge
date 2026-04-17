/**
 * Memory — three tiers, one interface.
 *
 *   Working   — the live message window for an agent.
 *   Episodic  — the durable, ordered trace of what happened.
 *   Semantic  — extracted facts/patterns indexed for relevance retrieval.
 *
 * Recall is the hot path. It returns items AND a RecallTrace that explains
 * why each item was selected — debuggability is a feature.
 */

import type { AgentId, ContractError, Result, SessionId, Timestamped } from "./common.js";
import type { PinScope } from "./pinned.js";

export type MemoryItemId = string;
export type MemoryTier = "working" | "episodic" | "semantic";

export interface MemoryItem extends Timestamped {
  readonly id: MemoryItemId;
  readonly tier: MemoryTier;
  readonly content: string;
  /** Free-form key/value, indexable. */
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  /** Embedding is optional at write time; the memory module may compute lazily. */
  readonly embedding?: ReadonlyArray<number>;
  /** Causal links to other items. */
  readonly links?: ReadonlyArray<MemoryLink>;
  /** Token cost of this item, as counted by the active provider. */
  readonly tokens?: number;
  /**
   * Pinned items survive every compression strategy. The Custodian's working
   * memory uses this for contract / topology / progress / allocation pins;
   * compression implementations MUST refuse to drop or summarize-away pinned
   * items. See `pinned.ts` and ADR 0016.
   */
  readonly pin?: PinScope;
}

export interface MemoryLink {
  readonly to: MemoryItemId;
  readonly kind: "caused" | "refers" | "summarizes" | "supersedes" | "contradicts";
  readonly weight?: number;
}

export interface RecallQuery {
  /** A natural-language query. May be empty if scope alone is sufficient. */
  readonly text?: string;
  /** Structured filter on attributes. */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
  /** Time window. */
  readonly since?: number;
  readonly until?: number;
}

export interface RecallScope {
  readonly session: SessionId;
  /** Restrict to specific tiers; default = all. */
  readonly tiers?: readonly MemoryTier[];
  /** Restrict to specific agents (e.g. only what *this* agent saw). */
  readonly agents?: readonly AgentId[];
}

export interface RecallBudget {
  /** Max items returned. */
  readonly maxItems?: number;
  /** Max total tokens across returned items. */
  readonly maxTokens?: number;
}

export interface RecallTrace {
  readonly items: readonly RecallTraceEntry[];
  readonly droppedForBudget: number;
}

export interface RecallTraceEntry {
  readonly itemId: MemoryItemId;
  readonly score: number;
  readonly components: Readonly<{
    semantic?: number;
    structural?: number;
    temporal?: number;
    causal?: number;
  }>;
  readonly reason: string;
}

export interface RecallResult {
  readonly items: readonly MemoryItem[];
  readonly trace: RecallTrace;
}

/**
 * The Memory contract.
 *
 * Implementations MUST:
 *   - persist episodic items durably (resume across processes)
 *   - emit RecallTrace entries for every returned item
 *   - respect RecallBudget; drop overflow into `trace.droppedForBudget`
 *
 * Implementations SHOULD:
 *   - run compression out-of-band (working → summary → semantic → archived)
 *   - update embeddings lazily, not on the hot path
 *   - re-render pinned items into the working tier on every recall
 */
export interface Memory {
  append(
    items: readonly Omit<MemoryItem, "id" | "createdAt">[],
  ): Promise<Result<readonly MemoryItemId[]>>;

  recall(
    query: RecallQuery,
    scope: RecallScope,
    budget: RecallBudget,
  ): Promise<Result<RecallResult>>;

  get(id: MemoryItemId): Promise<Result<MemoryItem | undefined>>;

  /** Manually mark an item for promotion/demotion across tiers. */
  retier(id: MemoryItemId, to: MemoryTier): Promise<Result<void, ContractError>>;
}
