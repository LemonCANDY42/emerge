/**
 * JSONL event schema — public, versioned contract.
 *
 * Every line written by the recorder, telemetry, or any other emerge component
 * to a JSONL file MUST conform to this schema. Downstream tools (CLI, TUI,
 * OTel exporter, web monitor) parse ONLY this format.
 *
 * Versioning policy (ADR 0037):
 *   - Additions (new optional fields, new event types) are minor-compatible.
 *   - Removals or renames of any field within a major version are FORBIDDEN.
 *   - Bump major (e.g. "1.0.0" → "2.0.0") only for breaking changes;
 *     document migration in docs/adr/ and update JSONL_SCHEMA_VERSION here.
 *   - The `v` field MUST be the first key in every line so fast parsers can
 *     reject mismatched versions before reading the full payload.
 */

import type { AgentState } from "./agent.js";
import type { BusEnvelope } from "./bus.js";
import type { AgentId, ContractId, SessionId, SpanId } from "./common.js";
import type { ProviderEvent, ProviderRequest } from "./provider.js";
import type { RecordedEvent } from "./replay.js";
import type { AssessmentInput, Recommendation } from "./surveillance.js";
import type { SpanEnd, SpanStart } from "./telemetry.js";
import type { ToolInvocation, ToolResult } from "./tool.js";

export const JSONL_SCHEMA_VERSION = "1.0.0" as const;
export type JsonlSchemaVersion = typeof JSONL_SCHEMA_VERSION;

/** Every JSONL event line must conform to one of these shapes. */
export type JsonlEvent =
  | {
      readonly v: JsonlSchemaVersion;
      readonly type: "session.start";
      readonly at: number;
      readonly sessionId: SessionId;
      readonly contractRef: ContractId;
    }
  | {
      readonly v: JsonlSchemaVersion;
      readonly type: "session.end";
      readonly at: number;
      readonly sessionId: SessionId;
    }
  | {
      readonly v: JsonlSchemaVersion;
      readonly type: "envelope";
      readonly at: number;
      readonly envelope: BusEnvelope;
    }
  | {
      readonly v: JsonlSchemaVersion;
      readonly type: "provider_call";
      readonly at: number;
      readonly req: ProviderRequest;
      readonly events: readonly ProviderEvent[];
    }
  | {
      readonly v: JsonlSchemaVersion;
      readonly type: "tool_call";
      readonly at: number;
      readonly call: ToolInvocation;
      readonly result: ToolResult;
    }
  | {
      readonly v: JsonlSchemaVersion;
      readonly type: "surveillance_recommendation";
      readonly at: number;
      readonly input: AssessmentInput;
      readonly recommendation: Recommendation;
    }
  | {
      readonly v: JsonlSchemaVersion;
      readonly type: "decision";
      readonly at: number;
      readonly agent: AgentId;
      readonly choice: string;
      readonly rationale: string;
    }
  | {
      readonly v: JsonlSchemaVersion;
      readonly type: "lifecycle";
      readonly at: number;
      readonly agent: AgentId;
      readonly transition: AgentState;
    }
  | {
      readonly v: JsonlSchemaVersion;
      readonly type: "span.start";
      readonly at: number;
      readonly span: SpanStart;
    }
  | {
      readonly v: JsonlSchemaVersion;
      readonly type: "span.end";
      readonly at: number;
      readonly span: SpanEnd;
    }
  | {
      readonly v: JsonlSchemaVersion;
      readonly type: "span.event";
      readonly at: number;
      readonly spanId: SpanId;
      readonly name: string;
      readonly attrs?: Readonly<Record<string, unknown>>;
    };

/**
 * Convert a RecordedEvent (from the replay contract) to a JsonlEvent.
 * The mapping is 1:1 — RecordedEvent.kind becomes JsonlEvent.type.
 */
export function fromRecordedEvent(e: RecordedEvent): JsonlEvent {
  switch (e.kind) {
    case "envelope":
      return { v: JSONL_SCHEMA_VERSION, type: "envelope", at: e.at, envelope: e.envelope };
    case "provider_call":
      return {
        v: JSONL_SCHEMA_VERSION,
        type: "provider_call",
        at: e.at,
        req: e.req,
        events: e.events,
      };
    case "tool_call":
      return {
        v: JSONL_SCHEMA_VERSION,
        type: "tool_call",
        at: e.at,
        call: e.call,
        result: e.result,
      };
    case "surveillance_recommendation":
      return {
        v: JSONL_SCHEMA_VERSION,
        type: "surveillance_recommendation",
        at: e.at,
        input: e.input,
        recommendation: e.recommendation,
      };
    case "decision":
      return {
        v: JSONL_SCHEMA_VERSION,
        type: "decision",
        at: e.at,
        agent: e.agent,
        choice: e.choice,
        rationale: e.rationale,
      };
    case "lifecycle":
      return {
        v: JSONL_SCHEMA_VERSION,
        type: "lifecycle",
        at: e.at,
        agent: e.agent,
        transition: e.transition,
      };
  }
}

/** Build a session.start JsonlEvent. */
export function sessionStartEvent(
  sessionId: SessionId,
  contractRef: ContractId,
  at = Date.now(),
): JsonlEvent {
  return { v: JSONL_SCHEMA_VERSION, type: "session.start", at, sessionId, contractRef };
}

/** Build a session.end JsonlEvent. */
export function sessionEndEvent(sessionId: SessionId, at = Date.now()): JsonlEvent {
  return { v: JSONL_SCHEMA_VERSION, type: "session.end", at, sessionId };
}

/** Build a span.start JsonlEvent. */
export function spanStartEvent(span: SpanStart, at = Date.now()): JsonlEvent {
  return { v: JSONL_SCHEMA_VERSION, type: "span.start", at, span };
}

/** Build a span.end JsonlEvent. */
export function spanEndEvent(span: SpanEnd, at = Date.now()): JsonlEvent {
  return { v: JSONL_SCHEMA_VERSION, type: "span.end", at, span };
}

/** Build a span.event JsonlEvent. */
export function spanEventEvent(
  spanId: SpanId,
  name: string,
  attrs?: Readonly<Record<string, unknown>>,
  at = Date.now(),
): JsonlEvent {
  const base = { v: JSONL_SCHEMA_VERSION, type: "span.event" as const, at, spanId, name };
  return attrs !== undefined ? { ...base, attrs } : base;
}

/**
 * Parse a single JSONL line into a JsonlEvent.
 *
 * Returns `{ ok: false, error }` for:
 *   - invalid JSON
 *   - missing or empty `type` field
 *   - mismatched `v` (schema version)
 *   - unknown `type` discriminant
 *
 * Callers (CLI) MUST treat a parse failure as fatal for that line.
 * Streaming consumers (TUI) MAY skip unknown-type lines after logging.
 */
export function parseJsonlLine(
  line: string,
):
  | { readonly ok: true; readonly event: JsonlEvent }
  | { readonly ok: false; readonly error: string } {
  if (!line.trim()) {
    return { ok: false, error: "empty line" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: `invalid JSON: ${line.slice(0, 80)}` };
  }

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "JSONL line is not a JSON object" };
  }

  const obj = raw as Record<string, unknown>;

  // Version check first — fast-reject before expensive field checks
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
  if (obj["v"] !== JSONL_SCHEMA_VERSION) {
    return {
      ok: false,
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
      error: `schema version mismatch: expected "${JSONL_SCHEMA_VERSION}", got "${String(obj["v"])}"`,
    };
  }

  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
  const type = obj["type"];
  if (typeof type !== "string") {
    return { ok: false, error: 'missing or non-string "type" field' };
  }

  const KNOWN_TYPES = new Set([
    "session.start",
    "session.end",
    "envelope",
    "provider_call",
    "tool_call",
    "surveillance_recommendation",
    "decision",
    "lifecycle",
    "span.start",
    "span.end",
    "span.event",
  ]);

  if (!KNOWN_TYPES.has(type)) {
    return { ok: false, error: `unknown event type: "${type}"` };
  }

  // We trust the shape at this point — callers who need field-level validation
  // should layer Zod on top of this function.
  return { ok: true, event: obj as unknown as JsonlEvent };
}
