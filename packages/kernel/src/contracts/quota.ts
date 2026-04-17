/**
 * Quota negotiation — first-class envelope flow between any agent and the
 * Custodian. When an agent foresees it cannot finish within budget but
 * believes the work is worth more, it requests; the Custodian decides; the
 * kernel applies the cap mutation atomically.
 */

import type { AgentId, ArtifactHandle, Budget, CorrelationId } from "./common.js";

export interface QuotaRequest {
  readonly correlationId: CorrelationId;
  readonly from: AgentId;
  readonly ask: Partial<Budget>;
  readonly rationale: string;
  readonly evidence?: readonly ArtifactHandle[];
  /** Self-imposed concessions the requester would accept. */
  readonly willTradeFor?: {
    readonly tier?: "draft" | "standard";
    readonly maxIterationsCut?: number;
  };
}

export type QuotaDecision =
  | { readonly kind: "grant"; readonly granted: Partial<Budget>; readonly rationale: string }
  | { readonly kind: "deny"; readonly reason: string }
  | {
      readonly kind: "partial";
      readonly granted: Partial<Budget>;
      readonly rationale: string;
    };

export interface QuotaLedgerEntry {
  readonly at: number;
  readonly request: QuotaRequest;
  readonly decision: QuotaDecision;
}

export interface QuotaLedger {
  readonly entries: readonly QuotaLedgerEntry[];
}
