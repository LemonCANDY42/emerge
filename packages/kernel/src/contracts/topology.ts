/**
 * Topology — a value, not a class.
 *
 * Topology helpers in `@lwrf42/emerge-agents` produce `Topology` values from
 * `AgentSpec[]` + a pattern descriptor. The kernel runs whatever topology
 * those helpers produce — the kernel knows nothing about "swarm" or "mesh".
 */

import type { AgentId } from "./common.js";

export type TopologyKind =
  | "supervisor-worker"
  | "worker-pool"
  | "swarm"
  | "mesh"
  | "tree"
  | "pipeline"
  | "debate"
  /** Custom user-defined topology kind. */
  | (string & {});

export interface TopologySpec {
  readonly kind: TopologyKind;
  /** Arbitrary kind-specific configuration. */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface TopologyMember {
  readonly agent: AgentId;
  /** Optional role within the topology (e.g. "supervisor", "worker", "judge"). */
  readonly role?: string;
}

export interface Topology {
  readonly spec: TopologySpec;
  readonly members: readonly TopologyMember[];
  /** Edges that exist by construction; the bus may carry traffic outside this set per ACL. */
  readonly edges: readonly TopologyEdge[];
  readonly nested?: readonly Topology[];
}

export interface TopologyEdge {
  readonly from: AgentId;
  readonly to: AgentId;
  readonly kind: "request" | "subscribe" | "broadcast";
}

/** A snapshot the Custodian publishes for observers. */
export interface TopologySnapshot {
  readonly at: number;
  readonly topology: Topology;
}

/** A delta describing how the topology evolved between two snapshots. */
export interface TopologyDelta {
  readonly at: number;
  readonly added: {
    readonly members: readonly TopologyMember[];
    readonly edges: readonly TopologyEdge[];
  };
  readonly removed: {
    readonly members: readonly AgentId[];
    readonly edges: readonly TopologyEdge[];
  };
}
