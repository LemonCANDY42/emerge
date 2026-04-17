/**
 * Pinned-context compression policy.
 *
 * `MemoryItem` (in memory.ts) grows a `pin?: PinScope` field. Compression
 * strategies MUST refuse to drop or summarize-away any item with `pin` set.
 * Pinned items may also be re-rendered into the working tier on every recall.
 *
 * The Custodian's working memory ships these pins by construction (contract,
 * topology snapshot, progress, resource ledger).
 */

export type PinScope =
  | "contract"
  | "topology"
  | "progress"
  | "allocation"
  /** User-defined scopes are allowed. */
  | (string & {});

export interface CompressionPolicyInvariants {
  /** Compression MUST NOT drop pinned items. */
  readonly preservesPins: true;
  /** If true, every recall re-renders pins into the working tier. */
  readonly rendersPinsOnRecall: boolean;
}
