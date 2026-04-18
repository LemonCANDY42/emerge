/**
 * InMemoryLineageGuard unit tests.
 *
 * Covers: depth refusal; spawn-cycle refusal; valid lineage accepted.
 */

import { describe, expect, it } from "vitest";
import type { AgentId, LineageEdge } from "../contracts/index.js";
import { InMemoryLineageGuard } from "./lineage-guard.js";

function id(s: string): AgentId {
  return s as AgentId;
}

describe("InMemoryLineageGuard", () => {
  it("allows spawning within depth limit", () => {
    const guard = new InMemoryLineageGuard({ maxDepth: 3 });
    const parent = id("root");
    const child = id("child");
    const result = guard.canSpawn(parent, child);
    expect(result.ok).toBe(true);
  });

  it("refuses spawning when depth would exceed maxDepth", () => {
    const guard = new InMemoryLineageGuard({ maxDepth: 1 });
    const root = id("root");
    const child = id("child");
    const grandchild = id("grandchild");

    guard.record({ parent: root, child, at: Date.now() } as LineageEdge);
    const result = guard.canSpawn(child, grandchild);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("E_LINEAGE_DEPTH");
  });

  it("refuses spawning when it would create a cycle", () => {
    const guard = new InMemoryLineageGuard({ maxDepth: 10 });
    const a = id("a");
    const b = id("b");

    guard.record({ parent: a, child: b, at: Date.now() } as LineageEdge);
    // Adding b → a would create a cycle
    const result = guard.canSpawn(b, a);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("E_LINEAGE_CYCLE");
  });

  it("records edges and tracks max depth", () => {
    const guard = new InMemoryLineageGuard({ maxDepth: 5 });
    const root = id("root");
    const c1 = id("c1");
    const c2 = id("c2");

    guard.record({ parent: root, child: c1, at: Date.now() } as LineageEdge);
    guard.record({ parent: c1, child: c2, at: Date.now() } as LineageEdge);

    const snap = guard.snapshot();
    expect(snap.edges.length).toBe(2);
    expect(snap.maxDepthSeen).toBe(2);
  });

  it("respects maxFanOut limit", () => {
    const guard = new InMemoryLineageGuard({ maxDepth: 5, maxFanOut: 2 });
    const root = id("root");
    const c1 = id("c1");
    const c2 = id("c2");
    const c3 = id("c3");

    guard.record({ parent: root, child: c1, at: Date.now() } as LineageEdge);
    guard.record({ parent: root, child: c2, at: Date.now() } as LineageEdge);

    const result = guard.canSpawn(root, c3);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("E_LINEAGE_FANOUT");
  });
});
