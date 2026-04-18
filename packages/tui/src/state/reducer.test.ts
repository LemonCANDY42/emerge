/**
 * Tests for the pure state reducer.
 *
 * These tests are load-bearing: reverting production reducer code causes them
 * to fail without touching the tests themselves.
 */

import type { AgentId, ContractId, SessionId } from "@emerge/kernel/contracts";
import { JSONL_SCHEMA_VERSION, type JsonlEvent } from "@emerge/kernel/contracts";
import { describe, expect, it } from "vitest";
import { applyEvent, applyEvents } from "./reducer.js";
import { EMPTY_STATE } from "./types.js";

const SESSION_ID = "sess-1" as SessionId;
const CONTRACT_ID = "contract-1" as ContractId;
const AGENT_A = "agent-a" as AgentId;
const AGENT_B = "agent-b" as AgentId;
const AGENT_C = "agent-c" as AgentId;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHandshake(id: AgentId, spawnedBy?: AgentId, role = "worker"): JsonlEvent {
  return {
    v: JSONL_SCHEMA_VERSION,
    type: "envelope",
    at: Date.now(),
    envelope: {
      kind: "handshake",
      correlationId: `corr-${id}` as import("@emerge/kernel/contracts").CorrelationId,
      sessionId: SESSION_ID,
      from: id,
      to: { kind: "broadcast" },
      timestamp: Date.now(),
      card: {
        id,
        role,
        description: `Agent ${String(id)}`,
        capabilities: {
          tools: [],
          modalities: ["text"],
          qualityTier: "standard",
          streaming: true,
          interrupts: false,
          maxConcurrency: 1,
        },
        io: {
          accepts: "any" as unknown as import("@emerge/kernel/contracts").SchemaRef,
          produces: "any" as unknown as import("@emerge/kernel/contracts").SchemaRef,
        },
        budget: { tokensIn: 1000, tokensOut: 500, usd: 1.0 },
        termination: {
          maxIterations: 10,
          maxWallMs: 60_000,
          budget: { tokensIn: 1000, tokensOut: 500 },
          retry: { transient: 1, nonRetryable: 0 },
          cycle: { windowSize: 5, repeatThreshold: 3 },
          done: { kind: "predicate", description: "end_turn" },
        },
        acl: {
          acceptsRequests: "any",
          acceptsQueries: "any",
          acceptsSignals: "any",
          acceptsNotifications: "any",
        },
        lineage: {
          spawnedBy,
          depth: spawnedBy !== undefined ? 1 : 0,
        },
      },
    } as import("@emerge/kernel/contracts").BusEnvelope,
  };
}

function makeLifecycle(
  agent: AgentId,
  transition: import("@emerge/kernel/contracts").AgentState = "thinking",
): JsonlEvent {
  return {
    v: JSONL_SCHEMA_VERSION,
    type: "lifecycle",
    at: Date.now(),
    agent,
    transition,
  };
}

function makeVerdict(
  from: AgentId,
  kind: "aligned" | "partial" | "off-track" | "failed",
): JsonlEvent {
  const verdict =
    kind === "aligned"
      ? { kind: "aligned" as const, rationale: "All good", evidence: [] }
      : kind === "partial"
        ? { kind: "partial" as const, missing: [], suggestion: "Try again" }
        : kind === "off-track"
          ? { kind: "off-track" as const, reason: "Wrong direction", suggestion: "Go back" }
          : { kind: "failed" as const, reason: "Hard failure" };

  return {
    v: JSONL_SCHEMA_VERSION,
    type: "envelope",
    at: 1_700_000_000_000,
    envelope: {
      kind: "verdict",
      correlationId: "corr-verdict" as import("@emerge/kernel/contracts").CorrelationId,
      sessionId: SESSION_ID,
      from,
      to: { kind: "broadcast" },
      timestamp: Date.now(),
      verdict,
    } as import("@emerge/kernel/contracts").BusEnvelope,
  };
}

function makeProviderCall(tokensIn: number, tokensOut: number, usd: number): JsonlEvent {
  return {
    v: JSONL_SCHEMA_VERSION,
    type: "provider_call",
    at: Date.now(),
    req: {
      messages: [],
    } as unknown as import("@emerge/kernel/contracts").ProviderRequest,
    events: [
      {
        type: "stop",
        reason: "end_turn",
        usage: { tokensIn, tokensOut, wallMs: 50, toolCalls: 0, usd },
      },
    ],
  };
}

function makeDecision(agent: AgentId, choice: string, rationale: string): JsonlEvent {
  return {
    v: JSONL_SCHEMA_VERSION,
    type: "decision",
    at: Date.now(),
    agent,
    choice,
    rationale,
  };
}

// ─── Topology tree tests ───────────────────────────────────────────────────────

describe("reducer: topology tree", () => {
  it("handshake creates agent node with correct parent", () => {
    const events: JsonlEvent[] = [
      makeHandshake(AGENT_A, undefined, "supervisor"),
      makeHandshake(AGENT_B, AGENT_A, "worker"),
      makeHandshake(AGENT_C, AGENT_A, "worker"),
    ];
    const state = applyEvents(events);

    expect(state.agents.size).toBe(3);
    expect(state.agents.get(AGENT_A)?.parentId).toBeUndefined();
    expect(state.agents.get(AGENT_B)?.parentId).toBe(AGENT_A);
    expect(state.agents.get(AGENT_C)?.parentId).toBe(AGENT_A);
  });

  it("lifecycle updates agent state", () => {
    const events: JsonlEvent[] = [
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
    ];
    const state = applyEvents(events);

    expect(state.agents.get(AGENT_A)?.state).toBe("thinking");
  });

  it("lifecycle without prior handshake creates agent under unknown-parent", () => {
    const events: JsonlEvent[] = [makeLifecycle(AGENT_A, "thinking")];
    const state = applyEvents(events);

    const node = state.agents.get(AGENT_A);
    expect(node).toBeDefined();
    expect(node?.state).toBe("thinking");

    // parentId should be "(unknown parent)" sentinel
    expect(node?.parentId).toBeDefined();
    expect(String(node?.parentId)).toBe("(unknown parent)");
  });

  it("most-recent lifecycle transition wins", () => {
    const events: JsonlEvent[] = [
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
      makeLifecycle(AGENT_A, "completed"),
    ];
    const state = applyEvents(events);

    expect(state.agents.get(AGENT_A)?.state).toBe("completed");
  });

  it("handshake after lifecycle preserves state", () => {
    const events: JsonlEvent[] = [
      makeLifecycle(AGENT_A, "thinking"),
      makeHandshake(AGENT_A, undefined),
    ];
    const state = applyEvents(events);

    // Handshake comes after lifecycle — state should be preserved
    expect(state.agents.get(AGENT_A)?.state).toBe("thinking");
  });
});

// ─── Verdict feed tests ───────────────────────────────────────────────────────

describe("reducer: verdict feed", () => {
  it("aligned verdict appears in feed with glyph ✓", () => {
    const state = applyEvent(EMPTY_STATE, makeVerdict(AGENT_A, "aligned"));
    expect(state.verdicts).toHaveLength(1);
    expect(state.verdicts[0]?.kind).toBe("aligned");
  });

  it("partial verdict maps to kind partial", () => {
    const state = applyEvent(EMPTY_STATE, makeVerdict(AGENT_A, "partial"));
    expect(state.verdicts[0]?.kind).toBe("partial");
  });

  it("off-track verdict maps to kind off-track", () => {
    const state = applyEvent(EMPTY_STATE, makeVerdict(AGENT_A, "off-track"));
    expect(state.verdicts[0]?.kind).toBe("off-track");
  });

  it("failed verdict maps to kind failed", () => {
    const state = applyEvent(EMPTY_STATE, makeVerdict(AGENT_A, "failed"));
    expect(state.verdicts[0]?.kind).toBe("failed");
  });

  it("verdict feed is capped at 10 entries", () => {
    let state = EMPTY_STATE;
    for (let i = 0; i < 15; i++) {
      state = applyEvent(state, makeVerdict(AGENT_A, "aligned"));
    }
    expect(state.verdicts).toHaveLength(10);
  });

  it("newest verdict appears first in the feed", () => {
    let state = EMPTY_STATE;
    state = applyEvent(state, makeVerdict(AGENT_A, "aligned"));
    state = applyEvent(state, makeVerdict(AGENT_B, "failed"));

    expect(state.verdicts[0]?.from).toBe(AGENT_B);
    expect(state.verdicts[1]?.from).toBe(AGENT_A);
  });
});

// ─── Cost meter tests ─────────────────────────────────────────────────────────

describe("reducer: cost meter", () => {
  it("provider_call with stop event updates usage for running agent", () => {
    const events: JsonlEvent[] = [
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
      makeProviderCall(100, 50, 0.01),
    ];
    const state = applyEvents(events);

    expect(state.hasUsageData).toBe(true);
    const usage = state.usage.get(AGENT_A);
    expect(usage).toBeDefined();
    expect(usage?.tokensIn).toBe(100);
    expect(usage?.tokensOut).toBe(50);
    expect(usage?.usd).toBeCloseTo(0.01);
  });

  it("aggregates multiple provider calls for same agent", () => {
    const events: JsonlEvent[] = [
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
      makeProviderCall(100, 50, 0.01),
      makeProviderCall(200, 100, 0.02),
    ];
    const state = applyEvents(events);

    const usage = state.usage.get(AGENT_A);
    expect(usage?.tokensIn).toBe(300);
    expect(usage?.tokensOut).toBe(150);
    expect(usage?.usd).toBeCloseTo(0.03);
    expect(state.totalUsd).toBeCloseTo(0.03);
  });

  it("shows no usage when no provider calls with usage", () => {
    const events: JsonlEvent[] = [
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
    ];
    const state = applyEvents(events);

    expect(state.hasUsageData).toBe(false);
  });

  it("attributes provider call to running agent via best-effort heuristic", () => {
    const events: JsonlEvent[] = [
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
      makeProviderCall(50, 25, 0.005),
    ];
    const state = applyEvents(events);

    // AGENT_A was running so it should get the cost
    expect(state.usage.has(AGENT_A)).toBe(true);
  });

  it("computes totalUsd correctly across multiple agents", () => {
    const events: JsonlEvent[] = [
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
      makeProviderCall(100, 50, 0.01),
      makeLifecycle(AGENT_A, "completed"),
      makeHandshake(AGENT_B, AGENT_A),
      makeLifecycle(AGENT_B, "thinking"),
      makeProviderCall(200, 100, 0.02),
    ];
    const state = applyEvents(events);

    expect(state.totalUsd).toBeCloseTo(0.03);
  });
});

// ─── Pinned context tests ─────────────────────────────────────────────────────

describe("reducer: pinned context", () => {
  it("decision with choice=pin adds to pinned items", () => {
    const events: JsonlEvent[] = [makeDecision(AGENT_A, "pin", "Important contract reference")];
    const state = applyEvents(events);

    expect(state.pinned).toHaveLength(1);
    expect(state.pinned[0]?.agent).toBe(AGENT_A);
    expect(state.pinned[0]?.rationale).toBe("Important contract reference");
  });

  it("decision with other choice does not add to pinned", () => {
    const events: JsonlEvent[] = [makeDecision(AGENT_A, "decompose", "Task too large")];
    const state = applyEvents(events);

    expect(state.pinned).toHaveLength(0);
  });

  it("multiple pin decisions accumulate", () => {
    const events: JsonlEvent[] = [
      makeDecision(AGENT_A, "pin", "Pin one"),
      makeDecision(AGENT_B, "pin", "Pin two"),
    ];
    const state = applyEvents(events);

    expect(state.pinned).toHaveLength(2);
  });
});

// ─── Event counting tests ─────────────────────────────────────────────────────

describe("reducer: event counting", () => {
  it("tracks total event count", () => {
    const events: JsonlEvent[] = [
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
      makeVerdict(AGENT_A, "aligned"),
    ];
    const state = applyEvents(events);

    expect(state.eventCount).toBe(3);
  });

  it("tracks kind histogram", () => {
    const events: JsonlEvent[] = [
      makeHandshake(AGENT_A, undefined),
      makeHandshake(AGENT_B, AGENT_A),
      makeLifecycle(AGENT_A, "thinking"),
    ];
    const state = applyEvents(events);

    // Both handshakes are "envelope" type; lifecycle is "lifecycle"
    expect(state.kindHistogram.get("envelope")).toBe(2);
    expect(state.kindHistogram.get("lifecycle")).toBe(1);
  });

  it("non-mutating events still increment counter", () => {
    const sessionStartEvent: JsonlEvent = {
      v: JSONL_SCHEMA_VERSION,
      type: "session.start",
      at: Date.now(),
      sessionId: SESSION_ID,
      contractRef: CONTRACT_ID,
    };
    const state = applyEvent(EMPTY_STATE, sessionStartEvent);
    expect(state.eventCount).toBe(1);
  });
});
