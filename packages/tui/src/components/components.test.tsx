/**
 * Component tests using ink-testing-library.
 *
 * These tests verify the rendered output of each TUI component.
 * They are load-bearing: reverting component code causes them to fail.
 *
 * ink-testing-library renders components to a virtual terminal and exposes
 * lastFrame() which returns the most-recently rendered string.
 */

import type { AgentId, ContractId, SessionId } from "@lwrf42/emerge-kernel/contracts";
import { JSONL_SCHEMA_VERSION, type JsonlEvent } from "@lwrf42/emerge-kernel/contracts";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { applyEvents } from "../state/reducer.js";
import { EMPTY_STATE } from "../state/types.js";
import { CostMeter } from "./CostMeter.js";
import { PinnedContext } from "./PinnedContext.js";
import { TopologyTree } from "./TopologyTree.js";
import { VerdictFeed } from "./VerdictFeed.js";

const SESSION_ID = "sess-test" as SessionId;
const AGENT_A = "supervisor-1" as AgentId;
const AGENT_B = "worker-a" as AgentId;
const AGENT_C = "worker-b" as AgentId;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHandshake(id: AgentId, spawnedBy?: AgentId, role = "worker"): JsonlEvent {
  return {
    v: JSONL_SCHEMA_VERSION,
    type: "envelope",
    at: Date.now(),
    envelope: {
      kind: "handshake",
      correlationId: `corr-${id}` as import("@lwrf42/emerge-kernel/contracts").CorrelationId,
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
          accepts: "any" as unknown as import("@lwrf42/emerge-kernel/contracts").SchemaRef,
          produces: "any" as unknown as import("@lwrf42/emerge-kernel/contracts").SchemaRef,
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
        lineage: { spawnedBy, depth: spawnedBy !== undefined ? 1 : 0 },
      },
    } as import("@lwrf42/emerge-kernel/contracts").BusEnvelope,
  };
}

function makeLifecycle(
  agent: AgentId,
  transition: import("@lwrf42/emerge-kernel/contracts").AgentState,
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
  at = 1_700_000_000_000,
): JsonlEvent {
  const verdict =
    kind === "aligned"
      ? { kind: "aligned" as const, rationale: "All criteria met", evidence: [] }
      : kind === "partial"
        ? { kind: "partial" as const, missing: [], suggestion: "Missing some items" }
        : kind === "off-track"
          ? { kind: "off-track" as const, reason: "Wrong direction", suggestion: "Redirect" }
          : { kind: "failed" as const, reason: "Critical failure" };

  return {
    v: JSONL_SCHEMA_VERSION,
    type: "envelope",
    at,
    envelope: {
      kind: "verdict",
      correlationId: "corr-v" as import("@lwrf42/emerge-kernel/contracts").CorrelationId,
      sessionId: SESSION_ID,
      from,
      to: { kind: "broadcast" },
      timestamp: at,
      verdict,
    } as import("@lwrf42/emerge-kernel/contracts").BusEnvelope,
  };
}

// ─── TopologyTree tests ───────────────────────────────────────────────────────

describe("TopologyTree component", () => {
  it("renders 'no agents' placeholder when state is empty", () => {
    const { lastFrame } = render(React.createElement(TopologyTree, { state: EMPTY_STATE }));
    const frame = lastFrame();
    expect(frame).toContain("no agents");
  });

  it("renders agent ids from handshake events", () => {
    const events = [makeHandshake(AGENT_A, undefined, "supervisor")];
    const state = applyEvents(events);
    const { lastFrame } = render(React.createElement(TopologyTree, { state }));
    expect(lastFrame()).toContain("supervisor-1");
  });

  it("renders parent-child tree structure", () => {
    const events = [
      makeHandshake(AGENT_A, undefined, "supervisor"),
      makeHandshake(AGENT_B, AGENT_A, "worker"),
      makeHandshake(AGENT_C, AGENT_A, "worker"),
    ];
    const state = applyEvents(events);
    const { lastFrame } = render(React.createElement(TopologyTree, { state }));
    const frame = lastFrame() ?? "";

    // All three agents should appear
    expect(frame).toContain("supervisor-1");
    expect(frame).toContain("worker-a");
    expect(frame).toContain("worker-b");
  });

  it("renders state badge for each agent", () => {
    const events = [
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
      makeHandshake(AGENT_B, AGENT_A),
      makeLifecycle(AGENT_B, "completed"),
    ];
    const state = applyEvents(events);
    const { lastFrame } = render(React.createElement(TopologyTree, { state }));
    const frame = lastFrame() ?? "";

    expect(frame).toContain("[thinking]");
    expect(frame).toContain("[completed]");
  });

  it("renders unknown-parent fallback for lifecycle-only agents", () => {
    const events = [makeLifecycle(AGENT_A, "thinking")];
    const state = applyEvents(events);
    const { lastFrame } = render(React.createElement(TopologyTree, { state }));
    const frame = lastFrame() ?? "";

    expect(frame).toContain("unknown parent");
    expect(frame).toContain("supervisor-1");
  });
});

// ─── VerdictFeed tests ────────────────────────────────────────────────────────

describe("VerdictFeed component", () => {
  it("renders 'no verdicts' placeholder when feed is empty", () => {
    const { lastFrame } = render(React.createElement(VerdictFeed, { state: EMPTY_STATE }));
    expect(lastFrame()).toContain("no verdicts");
  });

  it("renders ✓ glyph for aligned verdicts", () => {
    const state = applyEvents([makeVerdict(AGENT_A, "aligned")]);
    const { lastFrame } = render(React.createElement(VerdictFeed, { state }));
    expect(lastFrame()).toContain("✓");
  });

  it("renders ✗ glyph for failed verdicts", () => {
    const state = applyEvents([makeVerdict(AGENT_A, "failed")]);
    const { lastFrame } = render(React.createElement(VerdictFeed, { state }));
    expect(lastFrame()).toContain("✗");
  });

  it("renders ? glyph for partial verdicts", () => {
    const state = applyEvents([makeVerdict(AGENT_A, "partial")]);
    const { lastFrame } = render(React.createElement(VerdictFeed, { state }));
    expect(lastFrame()).toContain("?");
  });

  it("renders ? glyph for off-track verdicts", () => {
    const state = applyEvents([makeVerdict(AGENT_A, "off-track")]);
    const { lastFrame } = render(React.createElement(VerdictFeed, { state }));
    expect(lastFrame()).toContain("?");
  });

  it("renders agent id in the feed", () => {
    const state = applyEvents([makeVerdict(AGENT_A, "aligned")]);
    const { lastFrame } = render(React.createElement(VerdictFeed, { state }));
    expect(lastFrame()).toContain("supervisor-1");
  });

  it("renders up to 10 verdicts (cap enforced by reducer)", () => {
    let state = EMPTY_STATE;
    for (let i = 0; i < 12; i++) {
      state = applyEvents([makeVerdict(AGENT_A, "aligned")]);
      state = { ...state, verdicts: state.verdicts };
    }
    // Feed only 10 verdicts to state
    const manyEvents: JsonlEvent[] = [];
    for (let i = 0; i < 12; i++) {
      manyEvents.push(makeVerdict(AGENT_A, "aligned"));
    }
    const finalState = applyEvents(manyEvents);
    expect(finalState.verdicts).toHaveLength(10);

    const { lastFrame } = render(React.createElement(VerdictFeed, { state: finalState }));
    // All 10 rows should be present (aligned ✓)
    const frame = lastFrame() ?? "";
    const glyphCount = (frame.match(/✓/g) ?? []).length;
    expect(glyphCount).toBe(10);
  });
});

// ─── CostMeter tests ──────────────────────────────────────────────────────────

describe("CostMeter component", () => {
  it("shows 'no token data' message when no usage recorded", () => {
    const { lastFrame } = render(React.createElement(CostMeter, { state: EMPTY_STATE }));
    expect(lastFrame()).toContain("no token data");
  });

  it("shows TOTAL line when usage data exists", () => {
    const state = applyEvents([
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
      {
        v: JSONL_SCHEMA_VERSION,
        type: "provider_call",
        at: Date.now(),
        // biome-ignore format: inline type import must stay single-line
        req: { messages: [] } as unknown as import("@lwrf42/emerge-kernel/contracts").ProviderRequest,
        events: [
          {
            type: "stop",
            reason: "end_turn",
            usage: { tokensIn: 100, tokensOut: 50, wallMs: 50, toolCalls: 0, usd: 0.01 },
          },
        ],
      },
    ]);
    const { lastFrame } = render(React.createElement(CostMeter, { state }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("TOTAL");
    expect(frame).toContain("$0.010");
  });

  it("shows agent id in cost table", () => {
    const state = applyEvents([
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
      {
        v: JSONL_SCHEMA_VERSION,
        type: "provider_call",
        at: Date.now(),
        // biome-ignore format: inline type import must stay single-line
        req: { messages: [] } as unknown as import("@lwrf42/emerge-kernel/contracts").ProviderRequest,
        events: [
          {
            type: "stop",
            reason: "end_turn",
            usage: { tokensIn: 200, tokensOut: 100, wallMs: 50, toolCalls: 0, usd: 0.02 },
          },
        ],
      },
    ]);
    const { lastFrame } = render(React.createElement(CostMeter, { state }));
    expect(lastFrame()).toContain("supervisor-1");
  });
});

// ─── PinnedContext tests ──────────────────────────────────────────────────────

describe("PinnedContext component", () => {
  it("shows 'no pinned items' when no pins recorded", () => {
    const { lastFrame } = render(React.createElement(PinnedContext, { state: EMPTY_STATE }));
    expect(lastFrame()).toContain("no pinned items");
  });

  it("shows pinned item rationale", () => {
    const state = applyEvents([
      {
        v: JSONL_SCHEMA_VERSION,
        type: "decision",
        at: Date.now(),
        agent: AGENT_A,
        choice: "pin",
        rationale: "contract.master pinned for all workers",
      },
    ]);
    const { lastFrame } = render(React.createElement(PinnedContext, { state }));
    expect(lastFrame()).toContain("contract.master pinned for all workers");
  });
});

// ─── Bad JSONL line tolerance tests ──────────────────────────────────────────

describe("parser: bad JSONL line tolerance", () => {
  it("parseJsonlLine skips invalid JSON and does not crash", async () => {
    const { parseJsonlLine } = await import("@lwrf42/emerge-kernel/contracts");

    const badLine = "{not valid json at all";
    const result = parseJsonlLine(badLine);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid JSON");
    }
  });

  it("applyEvents skips nothing — reducer processes all valid events", () => {
    // Valid sequence: all events should be applied
    const events = [
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
      makeVerdict(AGENT_A, "aligned"),
    ];
    const state = applyEvents(events);

    expect(state.eventCount).toBe(3);
    expect(state.verdicts).toHaveLength(1);
    expect(state.agents.has(AGENT_A)).toBe(true);
  });
});

// ─── Parser integration test ───────────────────────────────────────────────────

describe("parser: readAllLines handles every JsonlEvent discriminant", () => {
  it("all known event types are handled by reducer without error", () => {
    const CONTRACT_ID = "c1" as ContractId;
    const allEventTypes: JsonlEvent[] = [
      {
        v: JSONL_SCHEMA_VERSION,
        type: "session.start",
        at: 1,
        sessionId: SESSION_ID,
        contractRef: CONTRACT_ID,
      },
      {
        v: JSONL_SCHEMA_VERSION,
        type: "session.end",
        at: 2,
        sessionId: SESSION_ID,
      },
      makeHandshake(AGENT_A, undefined),
      makeLifecycle(AGENT_A, "thinking"),
      makeVerdict(AGENT_A, "aligned"),
      {
        v: JSONL_SCHEMA_VERSION,
        type: "provider_call",
        at: Date.now(),
        // biome-ignore format: inline type import must stay single-line
        req: { messages: [] } as unknown as import("@lwrf42/emerge-kernel/contracts").ProviderRequest,
        events: [
          {
            type: "stop",
            reason: "end_turn",
            usage: { tokensIn: 10, tokensOut: 5, wallMs: 10, toolCalls: 0, usd: 0.001 },
          },
        ],
      },
      {
        v: JSONL_SCHEMA_VERSION,
        type: "tool_call",
        at: Date.now(),
        call: {
          toolCallId: "tc-1" as import("@lwrf42/emerge-kernel/contracts").ToolCallId,
          callerAgent: AGENT_A,
          name: "fs.read" as import("@lwrf42/emerge-kernel/contracts").ToolName,
          input: {},
        },
        result: { ok: true, preview: "done" },
      },
      {
        v: JSONL_SCHEMA_VERSION,
        type: "surveillance_recommendation",
        at: Date.now(),
        input: {} as unknown as import("@lwrf42/emerge-kernel/contracts").AssessmentInput,
        recommendation: { kind: "proceed", confidence: 0.9, rationale: "ok" },
      },
      {
        v: JSONL_SCHEMA_VERSION,
        type: "decision",
        at: Date.now(),
        agent: AGENT_A,
        choice: "proceed",
        rationale: "proceed",
      },
      {
        v: JSONL_SCHEMA_VERSION,
        type: "span.start",
        at: Date.now(),
        span: {
          id: "span-1" as import("@lwrf42/emerge-kernel/contracts").SpanId,
          kind: "agent_spawn",
          name: "spawn:agent-a",
          agent: AGENT_A,
          startedAt: Date.now(),
        },
      },
      {
        v: JSONL_SCHEMA_VERSION,
        type: "span.end",
        at: Date.now(),
        span: {
          id: "span-1" as import("@lwrf42/emerge-kernel/contracts").SpanId,
          endedAt: Date.now(),
          status: "ok",
          usage: { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
        },
      },
      {
        v: JSONL_SCHEMA_VERSION,
        type: "span.event",
        at: Date.now(),
        spanId: "span-1" as import("@lwrf42/emerge-kernel/contracts").SpanId,
        name: "checkpoint",
      },
    ];

    // All events should apply without throwing
    expect(() => applyEvents(allEventTypes)).not.toThrow();

    const state = applyEvents(allEventTypes);
    expect(state.eventCount).toBe(allEventTypes.length);
  });
});
