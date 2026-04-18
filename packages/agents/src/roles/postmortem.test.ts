/**
 * postmortem unit tests.
 *
 * Covers:
 *   - computeApproachFingerprint produces stable, identical hashes for same-structure sessions
 *   - computeApproachFingerprint produces different hashes for different structures
 *   - defaultAnalyze produces a stable approachFingerprint (not session-id-dependent)
 *   - defaultAnalyze extracts aligned=true when a verdict.aligned envelope is present
 *   - defaultAnalyze extracts aligned=false when no aligned verdict
 *   - defaultAnalyze populates decisionLessons from decision events
 *   - defaultAnalyze uses contractRef as taskType
 */

import type {
  AgentId,
  ContractId,
  CorrelationId,
  RecordedEvent,
  SessionId,
  SessionRecord,
} from "@emerge/kernel/contracts";
import { describe, expect, it } from "vitest";
import { computeApproachFingerprint, defaultAnalyze } from "./postmortem.js";

function sessionId(s: string): SessionId {
  return s as SessionId;
}

function agentId(s: string): AgentId {
  return s as AgentId;
}

function corrId(s: string): CorrelationId {
  return s as CorrelationId;
}

function contractId(s: string): ContractId {
  return s as ContractId;
}

function makeRecord(
  overrides: Partial<SessionRecord> & { events?: readonly RecordedEvent[] } = {},
): SessionRecord {
  return {
    sessionId: sessionId("session-test"),
    startedAt: 1000,
    endedAt: 2000,
    contractRef: contractId("contract-test"),
    schemaVersion: "1.0",
    events: [],
    ...overrides,
  };
}

function toolCallEvent(toolName: string): RecordedEvent {
  return {
    kind: "tool_call",
    at: Date.now(),
    call: {
      toolCallId: `tc-${toolName}` as import("@emerge/kernel/contracts").ToolCallId,
      callerAgent: agentId("test-agent"),
      name: toolName,
      input: {},
    },
    result: { ok: true, preview: "ok" },
  };
}

function decisionEvent(choice: string, rationale: string): RecordedEvent {
  return {
    kind: "decision",
    at: Date.now(),
    agent: agentId("test-agent"),
    choice,
    rationale,
  };
}

function verdictAlignedEvent(): RecordedEvent {
  return {
    kind: "envelope",
    at: Date.now(),
    envelope: {
      kind: "verdict",
      correlationId: corrId("corr-verdict"),
      sessionId: sessionId("session-test"),
      from: agentId("adjudicator-1"),
      to: { kind: "broadcast" },
      timestamp: Date.now(),
      verdict: {
        kind: "aligned",
        rationale: "All criteria met",
        evidence: [],
      },
    },
  };
}

describe("computeApproachFingerprint", () => {
  it("produces a 16-char hex string", () => {
    const record = makeRecord();
    const fp = computeApproachFingerprint(record);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces identical fingerprints for two records with the same tool/decision structure", () => {
    const events: readonly RecordedEvent[] = [
      toolCallEvent("fs.read"),
      decisionEvent("parallel", "chose parallel dispatch"),
      toolCallEvent("fs.write"),
    ];
    const record1 = makeRecord({ sessionId: sessionId("session-a"), events });
    const record2 = makeRecord({ sessionId: sessionId("session-b"), events });

    const fp1 = computeApproachFingerprint(record1);
    const fp2 = computeApproachFingerprint(record2);

    expect(fp1).toBe(fp2);
  });

  it("produces different fingerprints when tool sequence differs", () => {
    const events1: readonly RecordedEvent[] = [toolCallEvent("fs.read"), toolCallEvent("fs.write")];
    const events2: readonly RecordedEvent[] = [
      toolCallEvent("fs.read"),
      toolCallEvent("bash.exec"),
    ];

    const fp1 = computeApproachFingerprint(makeRecord({ events: events1 }));
    const fp2 = computeApproachFingerprint(makeRecord({ events: events2 }));

    expect(fp1).not.toBe(fp2);
  });

  it("produces different fingerprints when decision choices differ", () => {
    const events1: readonly RecordedEvent[] = [decisionEvent("parallel", "chose parallel")];
    const events2: readonly RecordedEvent[] = [decisionEvent("sequential", "chose sequential")];

    const fp1 = computeApproachFingerprint(makeRecord({ events: events1 }));
    const fp2 = computeApproachFingerprint(makeRecord({ events: events2 }));

    expect(fp1).not.toBe(fp2);
  });

  it("is stable across calls with the same input (pure function)", () => {
    const events: readonly RecordedEvent[] = [
      toolCallEvent("fs.read"),
      decisionEvent("parallel", "r"),
    ];
    const record = makeRecord({ events });

    expect(computeApproachFingerprint(record)).toBe(computeApproachFingerprint(record));
  });

  it("does NOT include session id in the fingerprint (same events, different session id → same fp)", () => {
    const events: readonly RecordedEvent[] = [toolCallEvent("tool-x")];
    const fp1 = computeApproachFingerprint(makeRecord({ sessionId: sessionId("sess-1"), events }));
    const fp2 = computeApproachFingerprint(makeRecord({ sessionId: sessionId("sess-2"), events }));
    expect(fp1).toBe(fp2);
  });
});

describe("defaultAnalyze", () => {
  it("returns exactly one Experience", async () => {
    const record = makeRecord();
    const exps = await defaultAnalyze(record);
    expect(exps.length).toBe(1);
  });

  it("uses contractRef as taskType", async () => {
    const record = makeRecord({ contractRef: contractId("my-contract") });
    const [exp] = await defaultAnalyze(record);
    expect(exp?.taskType).toBe("my-contract");
  });

  it("approachFingerprint matches computeApproachFingerprint output (not session id)", async () => {
    const events: readonly RecordedEvent[] = [
      toolCallEvent("fs.read"),
      decisionEvent("parallel", "r"),
    ];
    const record = makeRecord({ sessionId: sessionId("sess-unique-xyz"), events });

    const [exp] = await defaultAnalyze(record);
    const expectedFp = computeApproachFingerprint(record);

    expect(exp?.approachFingerprint).toBe(expectedFp);
    expect(exp?.approachFingerprint).not.toContain("sess-unique-xyz");
  });

  it("two different sessions with the same structure get the same fingerprint", async () => {
    const events: readonly RecordedEvent[] = [toolCallEvent("fs.read")];
    const [exp1] = await defaultAnalyze(makeRecord({ sessionId: sessionId("s1"), events }));
    const [exp2] = await defaultAnalyze(makeRecord({ sessionId: sessionId("s2"), events }));

    expect(exp1?.approachFingerprint).toBe(exp2?.approachFingerprint);
  });

  it("sets outcomes.aligned=true when a verdict.aligned envelope is present", async () => {
    const record = makeRecord({ events: [verdictAlignedEvent()] });
    const [exp] = await defaultAnalyze(record);
    expect(exp?.outcomes.aligned).toBe(true);
  });

  it("sets outcomes.aligned=false when no aligned verdict", async () => {
    const record = makeRecord({ events: [toolCallEvent("fs.read")] });
    const [exp] = await defaultAnalyze(record);
    expect(exp?.outcomes.aligned).toBe(false);
  });

  it("populates decisionLessons from decision events", async () => {
    const record = makeRecord({
      events: [
        decisionEvent("parallel", "rationale for parallel"),
        decisionEvent("sequential", "rationale for sequential"),
      ],
    });
    const [exp] = await defaultAnalyze(record);
    expect(exp?.decisionLessons.length).toBe(2);
    expect(exp?.decisionLessons[0]?.stepDescription).toBe("parallel");
    expect(exp?.decisionLessons[1]?.stepDescription).toBe("sequential");
  });

  it("populates provenance.sourceSessions with the record's sessionId", async () => {
    const record = makeRecord({ sessionId: sessionId("session-prov") });
    const [exp] = await defaultAnalyze(record);
    expect(exp?.provenance.sourceSessions).toContain(sessionId("session-prov"));
  });

  it("computes wallMs from startedAt and endedAt", async () => {
    const record = makeRecord({ startedAt: 1000, endedAt: 5000 });
    const [exp] = await defaultAnalyze(record);
    expect(exp?.outcomes.wallMs).toBe(4000);
  });
});
