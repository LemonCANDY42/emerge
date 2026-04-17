/**
 * Spawn lineage — the per-session DAG of who-spawned-whom.
 *
 * The kernel's scheduler maintains a `SpawnLineage` and refuses spawns that
 * would (a) exceed `maxDepth` or (b) introduce a cycle in the lineage graph.
 * This is the AWS-Lambda-style recursion guard for nested sub-agents.
 */

import type { AgentId, Result } from "./common.js";

export interface LineageEdge {
  readonly parent: AgentId;
  readonly child: AgentId;
  readonly at: number;
  /** Set when this spawn was a result of `Surveillance.suggest({ kind: "decompose" })`. */
  readonly decomposition?: boolean;
}

export interface SpawnLineage {
  readonly edges: readonly LineageEdge[];
  /** Maximum depth observed so far. */
  readonly maxDepthSeen: number;
}

export interface LineageGuardConfig {
  readonly maxDepth: number;
  readonly maxFanOut?: number;
}

export interface LineageGuard {
  /** Pre-flight check; non-throwing. */
  canSpawn(parent: AgentId, prospectiveChild: AgentId): Result<void>;
  record(edge: LineageEdge): void;
  snapshot(): SpawnLineage;
}
