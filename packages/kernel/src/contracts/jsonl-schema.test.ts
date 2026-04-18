/**
 * Tests for the JSONL event schema contract (ADR 0037).
 *
 * Each test is load-bearing: reverting production code causes it to fail.
 * Coverage:
 *   - Round-trip every event kind
 *   - parseJsonlLine rejects unknown type
 *   - parseJsonlLine rejects mismatched schema version
 *   - parseJsonlLine rejects invalid JSON
 *   - parseJsonlLine rejects empty line
 *   - fromRecordedEvent maps all RecordedEvent kinds
 */

import { describe, expect, it } from "vitest";
import type { AgentId, ContractId, SessionId, SpanId } from "./common.js";
import {
  JSONL_SCHEMA_VERSION,
  type JsonlEvent,
  fromRecordedEvent,
  parseJsonlLine,
  sessionEndEvent,
  sessionStartEvent,
  spanEndEvent,
  spanEventEvent,
  spanStartEvent,
} from "./jsonl-schema.js";
import type { RecordedEvent } from "./replay.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function roundTrip(event: JsonlEvent): JsonlEvent {
  const line = JSON.stringify(event);
  const result = parseJsonlLine(line);
  if (!result.ok) throw new Error(`parseJsonlLine failed: ${result.error}`);
  return result.event;
}

const sessionId = "sess-test" as SessionId;
const contractRef = "contract-test" as ContractId;
const spanId = "span-1" as SpanId;
const agentId = "agent-1" as AgentId;

// ─── Round-trip tests for every event kind ──────────────────────────────────

describe("jsonl-schema round-trip", () => {
  it("session.start round-trips", () => {
    const event = sessionStartEvent(sessionId, contractRef, 1000);
    const parsed = roundTrip(event);
    expect(parsed).toEqual(event);
    expect(parsed.type).toBe("session.start");
    expect(parsed.v).toBe(JSONL_SCHEMA_VERSION);
  });

  it("session.end round-trips", () => {
    const event = sessionEndEvent(sessionId, 2000);
    const parsed = roundTrip(event);
    expect(parsed).toEqual(event);
    expect(parsed.type).toBe("session.end");
  });

  it("span.start round-trips", () => {
    const event = spanStartEvent(
      {
        id: spanId,
        kind: "agent_spawn",
        name: "spawn:agent-1",
        agent: agentId,
        startedAt: 1000,
      },
      1000,
    );
    const parsed = roundTrip(event);
    expect(parsed).toEqual(event);
    expect(parsed.type).toBe("span.start");
  });

  it("span.end round-trips", () => {
    const event = spanEndEvent(
      {
        id: spanId,
        endedAt: 2000,
        status: "ok",
        usage: { tokensIn: 10, tokensOut: 5, wallMs: 100, toolCalls: 0, usd: 0.001 },
      },
      2000,
    );
    const parsed = roundTrip(event);
    expect(parsed).toEqual(event);
    expect(parsed.type).toBe("span.end");
  });

  it("span.event round-trips (with attrs)", () => {
    const event = spanEventEvent(spanId, "tool_executed", { tool: "fs.read", ok: true }, 1500);
    const parsed = roundTrip(event);
    expect(parsed).toEqual(event);
    expect(parsed.type).toBe("span.event");
  });

  it("span.event round-trips (no attrs)", () => {
    const event = spanEventEvent(spanId, "checkpoint", undefined, 1600);
    const parsed = roundTrip(event);
    // attrs should not be present when undefined
    expect(parsed.type).toBe("span.event");
    expect((parsed as { attrs?: unknown }).attrs).toBeUndefined();
  });

  it("lifecycle round-trips", () => {
    const event: JsonlEvent = {
      v: JSONL_SCHEMA_VERSION,
      type: "lifecycle",
      at: 1000,
      agent: agentId,
      transition: "idle",
    };
    const parsed = roundTrip(event);
    expect(parsed).toEqual(event);
    expect(parsed.type).toBe("lifecycle");
  });

  it("decision round-trips", () => {
    const event: JsonlEvent = {
      v: JSONL_SCHEMA_VERSION,
      type: "decision",
      at: 1000,
      agent: agentId,
      choice: "decompose",
      rationale: "task too large",
    };
    const parsed = roundTrip(event);
    expect(parsed).toEqual(event);
    expect(parsed.type).toBe("decision");
  });

  it("envelope round-trips", () => {
    // Use a minimal valid envelope shape cast through unknown for test purposes
    const env = {
      kind: "handshake",
      correlationId: "corr-1",
      sessionId: "sess-test",
      from: agentId,
      to: { kind: "broadcast" },
      timestamp: 1000,
      card: { id: agentId, role: "worker" },
    };
    const event: JsonlEvent = {
      v: JSONL_SCHEMA_VERSION,
      type: "envelope",
      at: 1000,
      envelope: env as unknown as import("./bus.js").BusEnvelope,
    };
    const parsed = roundTrip(event);
    expect(parsed.type).toBe("envelope");
    expect((parsed as { envelope: unknown }).envelope).toEqual(env);
  });

  it("provider_call round-trips", () => {
    const event: JsonlEvent = {
      v: JSONL_SCHEMA_VERSION,
      type: "provider_call",
      at: 1000,
      req: {
        messages: [],
        tools: [],
        system: undefined,
        maxTokens: 100,
        providerOptions: {},
      } as unknown as import("./provider.js").ProviderRequest,
      events: [{ type: "text_delta", text: "hello" }],
    };
    const parsed = roundTrip(event);
    expect(parsed.type).toBe("provider_call");
  });

  it("tool_call round-trips", () => {
    const event: JsonlEvent = {
      v: JSONL_SCHEMA_VERSION,
      type: "tool_call",
      at: 1000,
      call: {
        toolCallId: "tc-1" as import("./common.js").ToolCallId,
        callerAgent: agentId,
        name: "fs.read" as import("./tool.js").ToolName,
        input: { path: "/tmp/test.txt" },
      },
      result: {
        ok: true,
        preview: "file contents",
      },
    };
    const parsed = roundTrip(event);
    expect(parsed.type).toBe("tool_call");
  });

  it("surveillance_recommendation round-trips", () => {
    const event: JsonlEvent = {
      v: JSONL_SCHEMA_VERSION,
      type: "surveillance_recommendation",
      at: 1000,
      input: {
        stepId: "step-1",
        difficulty: "medium",
        providerCapabilities: {
          id: "mock",
          maxContextTokens: 1000,
          supportedModalities: ["text"],
          ceiling: "medium",
          costPerTokenIn: 0,
          costPerTokenOut: 0,
        },
      } as unknown as import("./surveillance.js").AssessmentInput,
      recommendation: { kind: "proceed", confidence: 0.9, rationale: "provider capable" },
    };
    const parsed = roundTrip(event);
    expect(parsed.type).toBe("surveillance_recommendation");
  });
});

// ─── fromRecordedEvent ───────────────────────────────────────────────────────

describe("fromRecordedEvent", () => {
  it("maps envelope kind", () => {
    const e: RecordedEvent = {
      kind: "envelope",
      at: 1000,
      envelope: { kind: "handshake" } as unknown as import("./bus.js").BusEnvelope,
    };
    const mapped = fromRecordedEvent(e);
    expect(mapped.type).toBe("envelope");
    expect(mapped.v).toBe(JSONL_SCHEMA_VERSION);
  });

  it("maps provider_call kind", () => {
    const e: RecordedEvent = {
      kind: "provider_call",
      at: 1000,
      req: {} as unknown as import("./provider.js").ProviderRequest,
      events: [],
    };
    const mapped = fromRecordedEvent(e);
    expect(mapped.type).toBe("provider_call");
  });

  it("maps tool_call kind", () => {
    const e: RecordedEvent = {
      kind: "tool_call",
      at: 1000,
      call: {
        toolCallId: "tc-1" as import("./common.js").ToolCallId,
        callerAgent: agentId,
        name: "fs.read" as import("./tool.js").ToolName,
        input: {},
      },
      result: { ok: true, preview: "done" },
    };
    const mapped = fromRecordedEvent(e);
    expect(mapped.type).toBe("tool_call");
  });

  it("maps surveillance_recommendation kind", () => {
    const e: RecordedEvent = {
      kind: "surveillance_recommendation",
      at: 1000,
      input: {} as unknown as import("./surveillance.js").AssessmentInput,
      recommendation: { kind: "proceed", confidence: 1, rationale: "ok" },
    };
    const mapped = fromRecordedEvent(e);
    expect(mapped.type).toBe("surveillance_recommendation");
  });

  it("maps decision kind", () => {
    const e: RecordedEvent = {
      kind: "decision",
      at: 1000,
      agent: agentId,
      choice: "proceed",
      rationale: "fine",
    };
    const mapped = fromRecordedEvent(e);
    expect(mapped.type).toBe("decision");
    expect(mapped.v).toBe(JSONL_SCHEMA_VERSION);
  });

  it("maps lifecycle kind", () => {
    const e: RecordedEvent = {
      kind: "lifecycle",
      at: 1000,
      agent: agentId,
      transition: "idle",
    };
    const mapped = fromRecordedEvent(e);
    expect(mapped.type).toBe("lifecycle");
  });
});

// ─── parseJsonlLine error cases ──────────────────────────────────────────────

describe("parseJsonlLine errors", () => {
  it("returns error for empty line", () => {
    const result = parseJsonlLine("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("empty");
  });

  it("returns error for invalid JSON", () => {
    const result = parseJsonlLine("{not valid json}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid JSON");
  });

  it("returns clear error for mismatched schema version", () => {
    const line = JSON.stringify({
      v: "99.0.0",
      type: "session.start",
      at: 1,
      sessionId: "s",
      contractRef: "c",
    });
    const result = parseJsonlLine(line);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("schema version mismatch");
      expect(result.error).toContain("99.0.0");
      expect(result.error).toContain(JSONL_SCHEMA_VERSION);
    }
  });

  it("returns error for unknown type", () => {
    const line = JSON.stringify({ v: JSONL_SCHEMA_VERSION, type: "unknown.future.type", at: 1 });
    const result = parseJsonlLine(line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unknown event type");
  });

  it("returns error for missing type field", () => {
    const line = JSON.stringify({ v: JSONL_SCHEMA_VERSION, at: 1 });
    const result = parseJsonlLine(line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("type");
  });

  it("returns error when v is absent", () => {
    const line = JSON.stringify({ type: "session.start", at: 1, sessionId: "s", contractRef: "c" });
    const result = parseJsonlLine(line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("schema version mismatch");
  });
});
