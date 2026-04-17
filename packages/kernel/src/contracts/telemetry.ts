/**
 * Telemetry — tracing, token accounting, eval hooks.
 *
 * The kernel emits a span for every meaningful decision (provider call,
 * tool invocation, surveillance recommendation, sub-agent spawn). Telemetry
 * implementations may forward to OTel, write JSONL, or both.
 */

import type { AgentId, BudgetUsage, SpanId, TaskId, TraceContext } from "./common.js";

export type SpanKind =
  | "provider_call"
  | "tool_call"
  | "memory_recall"
  | "surveillance_assess"
  | "agent_spawn"
  | "agent_step"
  | "bus_envelope"
  | "quota_negotiation"
  | "human_request"
  | "task";

export interface SpanStart {
  readonly id: SpanId;
  readonly parent?: SpanId;
  readonly kind: SpanKind;
  readonly name: string;
  readonly agent?: AgentId;
  readonly task?: TaskId;
  /** W3C Trace Context — propagates across spawns and bus envelopes. */
  readonly traceContext?: TraceContext;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
  readonly startedAt: number;
}

export interface SpanEnd {
  readonly id: SpanId;
  readonly endedAt: number;
  readonly status: "ok" | "error";
  readonly error?: { code: string; message: string };
  readonly usage?: BudgetUsage;
}

export interface Telemetry {
  start(span: SpanStart): void;
  end(span: SpanEnd): void;
  /** Free-form event attached to the current span. */
  event(spanId: SpanId, name: string, attrs?: Readonly<Record<string, unknown>>): void;
}
