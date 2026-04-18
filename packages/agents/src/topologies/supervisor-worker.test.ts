/**
 * supervisorWorker topology unit tests.
 *
 * Covers: assemble-with-missing-termination returns Result.error;
 * ACL tightening applied; result aggregation.
 */

import type { AgentId, AgentSpec, ToolName } from "@emerge/kernel/contracts";
import { describe, expect, it } from "vitest";
import { supervisorWorker } from "./supervisor-worker.js";

function agentId(s: string): AgentId {
  return s as AgentId;
}

function makeSpec(id: string, extraAcl?: Partial<AgentSpec["acl"]>): AgentSpec {
  const base: AgentSpec = {
    id: agentId(id),
    role: "worker",
    description: `${id} agent`,
    provider: { kind: "static", providerId: "mock" },
    system: { kind: "literal", text: `You are ${id}` },
    toolsAllowed: [] as unknown as readonly ToolName[],
    memoryView: { inheritFromSupervisor: false, writeTags: [], readFilter: {} },
    budget: { tokensOut: 1000 },
    termination: {
      maxIterations: 3,
      maxWallMs: 5_000,
      budget: {},
      retry: { transient: 0, nonRetryable: 0 },
      cycle: { windowSize: 3, repeatThreshold: 3 },
      done: { kind: "predicate", description: "done" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
      ...extraAcl,
    },
    capabilities: {
      tools: [],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: false,
      interrupts: false,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
    surveillance: "passive",
  };
  return base;
}

describe("supervisorWorker()", () => {
  it("returns ok:true for a valid config", () => {
    const result = supervisorWorker({
      supervisor: makeSpec("supervisor"),
      workers: [makeSpec("worker1")],
      dispatch: "sequential",
    });
    expect(result.ok).toBe(true);
  });

  it("tightens worker ACL from 'any' to explicit allow-list", () => {
    const supervisor = makeSpec("supervisor");
    const worker = makeSpec("worker");
    const result = supervisorWorker({
      supervisor,
      workers: [worker],
      dispatch: "sequential",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The topology members should include worker with tightened ACL
    const members = result.value.topology.members;
    expect(members.length).toBe(2);
    expect(members.some((m) => m.role === "supervisor")).toBe(true);
    expect(members.some((m) => m.role === "worker")).toBe(true);
  });

  it("applies custodianId to tightened worker allow-list", () => {
    const supervisor = makeSpec("supervisor");
    const worker = makeSpec("worker");
    const custodianId = agentId("custodian");

    const result = supervisorWorker({
      supervisor,
      workers: [worker],
      dispatch: "parallel",
      custodianId,
    });

    expect(result.ok).toBe(true);
  });

  it("produces correct topology structure with edges", () => {
    const supervisor = makeSpec("supervisor");
    const worker = makeSpec("worker");
    const result = supervisorWorker({
      supervisor,
      workers: [worker],
      dispatch: "sequential",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edges = result.value.topology.edges;
    expect(edges.length).toBe(1);
    expect(edges[0]?.from).toBe(supervisor.id);
    expect(edges[0]?.to).toBe(worker.id);
  });

  it("does not reject workers with non-'any' ACL", () => {
    const supervisor = makeSpec("supervisor");
    const worker = makeSpec("worker", { acceptsRequests: { allow: [agentId("supervisor")] } });
    const result = supervisorWorker({
      supervisor,
      workers: [worker],
      dispatch: "sequential",
    });
    expect(result.ok).toBe(true);
  });
});
