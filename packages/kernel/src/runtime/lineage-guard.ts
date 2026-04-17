/**
 * InMemoryLineageGuard — maintains the spawn DAG, enforces depth and cycle detection.
 */

import type {
  AgentId,
  LineageEdge,
  LineageGuard,
  LineageGuardConfig,
  Result,
  SpawnLineage,
} from "../contracts/index.js";

export class InMemoryLineageGuard implements LineageGuard {
  private readonly edges: LineageEdge[] = [];
  private readonly config: LineageGuardConfig;
  private maxDepthSeen = 0;

  constructor(config: LineageGuardConfig) {
    this.config = config;
  }

  canSpawn(parent: AgentId, prospectiveChild: AgentId): Result<void> {
    // depth check — find parent's depth
    const parentDepth = this.depthOf(parent);
    const childDepth = parentDepth + 1;

    if (childDepth > this.config.maxDepth) {
      return {
        ok: false,
        error: {
          code: "E_LINEAGE_DEPTH",
          message: `spawn depth ${childDepth} exceeds maxDepth ${this.config.maxDepth}`,
        },
      };
    }

    // fan-out check
    if (this.config.maxFanOut !== undefined) {
      const children = this.edges.filter((e) => e.parent === parent).length;
      if (children >= this.config.maxFanOut) {
        return {
          ok: false,
          error: {
            code: "E_LINEAGE_FANOUT",
            message: `agent ${parent} already has ${children} children (maxFanOut=${this.config.maxFanOut})`,
          },
        };
      }
    }

    // cycle check — would adding parent→child create a cycle?
    if (this.wouldCycle(parent, prospectiveChild)) {
      return {
        ok: false,
        error: {
          code: "E_LINEAGE_CYCLE",
          message: `spawning ${prospectiveChild} from ${parent} would create a cycle`,
        },
      };
    }

    return { ok: true, value: undefined };
  }

  record(edge: LineageEdge): void {
    this.edges.push(edge);
    const depth = this.depthOf(edge.child);
    if (depth > this.maxDepthSeen) this.maxDepthSeen = depth;
  }

  snapshot(): SpawnLineage {
    return { edges: [...this.edges], maxDepthSeen: this.maxDepthSeen };
  }

  private depthOf(agent: AgentId): number {
    // BFS upward through parent edges
    let depth = 0;
    let current: AgentId | undefined = agent;
    const visited = new Set<AgentId>();
    while (current !== undefined) {
      if (visited.has(current)) break;
      visited.add(current);
      const parentEdge = this.edges.find((e) => e.child === current);
      if (!parentEdge) break;
      depth++;
      current = parentEdge.parent;
    }
    return depth;
  }

  private wouldCycle(parent: AgentId, child: AgentId): boolean {
    // If child is an ancestor of parent, adding parent→child creates a cycle.
    const ancestors = new Set<AgentId>();
    let current: AgentId | undefined = parent;
    while (current !== undefined) {
      if (ancestors.has(current)) break;
      ancestors.add(current);
      const edge = this.edges.find((e) => e.child === current);
      current = edge?.parent;
    }
    return ancestors.has(child);
  }
}
