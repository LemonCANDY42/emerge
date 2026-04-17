/**
 * Contract Custodian — kernel-aware role.
 *
 * Holds the master `Contract` immutably; owns the `pinned` memory tier;
 * mediates quota; maintains a topology snapshot stream + topology-evolution
 * log; runs the artifact pipeline. Its WORKING memory is required to host
 * the contract, current topology, current progress, and resource ledger as
 * `pin: PinScope` items so they survive every compression strategy.
 */

import type { Artifact, ArtifactInput } from "./artifact.js";
import type { ArtifactHandle } from "./common.js";
import type { Contract } from "./contract.js";
import type { MemoryItem } from "./memory.js";
import type { PinScope } from "./pinned.js";
import type { QuotaDecision, QuotaLedger, QuotaRequest } from "./quota.js";
import type { TopologyDelta, TopologySnapshot } from "./topology.js";

export interface Custodian {
  contract(): Contract;

  topologySnapshot(): TopologySnapshot;
  topologyHistory(window: TimeWindow): readonly TopologyDelta[];

  resourceLedger(): QuotaLedger;
  receiveQuotaRequest(req: QuotaRequest): Promise<QuotaDecision>;

  putArtifact(input: ArtifactInput): Promise<ArtifactHandle>;
  getArtifact(handle: ArtifactHandle): Promise<Artifact>;

  pin(item: MemoryItem, scope: PinScope): Promise<void>;
  pins(scope?: PinScope): readonly MemoryItem[];
}

export interface TimeWindow {
  readonly sinceMs?: number;
  readonly untilMs?: number;
}

export interface ProgressSnapshot {
  readonly contractId: Contract["id"];
  readonly completedCriteria: number;
  readonly totalCriteria: number;
  readonly notes?: string;
}
