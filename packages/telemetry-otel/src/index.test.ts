/**
 * Tests for OtelTelemetry adapter.
 *
 * Uses @opentelemetry/sdk-trace-base InMemorySpanExporter + SimpleSpanProcessor
 * to capture emitted spans without running a real OTel collector.
 *
 * Tests verify the adapter logic — attribute mapping, span lifecycle, and
 * addEvent wiring — not OTel SDK internals.
 */

import type { AgentId, SpanId } from "@emerge/kernel/contracts";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OtelTelemetry } from "./index.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
  const tracer = provider.getTracer("emerge-test");
  const telemetry = new OtelTelemetry({ tracer, serviceName: "test-service" });
  return { exporter, provider, telemetry };
}

const agentId = "agent-test" as AgentId;
const spanId = "span-abc" as SpanId;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("OtelTelemetry", () => {
  let exporter: InMemorySpanExporter;
  let telemetry: OtelTelemetry;

  beforeEach(() => {
    const s = setup();
    exporter = s.exporter;
    telemetry = s.telemetry;
  });

  afterEach(() => {
    exporter.reset();
  });

  it("produces a span with emerge.span.kind attribute", () => {
    telemetry.start({
      id: spanId,
      kind: "agent_spawn",
      name: "spawn:agent-test",
      agent: agentId,
      startedAt: Date.now(),
    });
    telemetry.end({ id: spanId, endedAt: Date.now(), status: "ok" });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span).toBeDefined();
    if (!span) return;
    expect(span.name).toBe("spawn:agent-test");
    expect(span.attributes["emerge.span.kind"]).toBe("agent_spawn");
    expect(span.attributes["emerge.service"]).toBe("test-service");
    expect(span.attributes["emerge.agent.id"]).toBe(agentId);
  });

  it("sets status OK on successful end", () => {
    telemetry.start({ id: spanId, kind: "task", name: "task:1", startedAt: Date.now() });
    telemetry.end({ id: spanId, endedAt: Date.now(), status: "ok" });

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    if (!span) return;
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("sets status ERROR with code and message on failed end", () => {
    telemetry.start({ id: spanId, kind: "tool_call", name: "tool:fs.read", startedAt: Date.now() });
    telemetry.end({
      id: spanId,
      endedAt: Date.now(),
      status: "error",
      error: { code: "E_NOT_FOUND", message: "file not found" },
    });

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    if (!span) return;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("file not found");
    expect(span.attributes["emerge.error.code"]).toBe("E_NOT_FOUND");
    expect(span.attributes["emerge.error.message"]).toBe("file not found");
  });

  it("maps BudgetUsage to emerge.usage.* attributes", () => {
    telemetry.start({
      id: spanId,
      kind: "provider_call",
      name: "provider:1",
      startedAt: Date.now(),
    });
    telemetry.end({
      id: spanId,
      endedAt: Date.now(),
      status: "ok",
      usage: { tokensIn: 100, tokensOut: 50, wallMs: 200, toolCalls: 1, usd: 0.005 },
    });

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    if (!span) return;
    expect(span.attributes["emerge.usage.tokensIn"]).toBe(100);
    expect(span.attributes["emerge.usage.tokensOut"]).toBe(50);
    expect(span.attributes["emerge.usage.wallMs"]).toBe(200);
    expect(span.attributes["emerge.usage.toolCalls"]).toBe(1);
    expect(span.attributes["emerge.usage.usd"]).toBe(0.005);
  });

  it("attaches addEvent calls for event()", () => {
    telemetry.start({ id: spanId, kind: "bus_envelope", name: "bus:1", startedAt: Date.now() });
    telemetry.event(spanId, "tool_started", { tool: "fs.write", retry: 0 });
    telemetry.event(spanId, "tool_done");
    telemetry.end({ id: spanId, endedAt: Date.now(), status: "ok" });

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    if (!span) return;
    expect(span.events).toHaveLength(2);
    expect(span.events[0]?.name).toBe("tool_started");
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(span.events[0]?.attributes?.["tool"]).toBe("fs.write");
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(span.events[0]?.attributes?.["retry"]).toBe(0);
    expect(span.events[1]?.name).toBe("tool_done");
  });

  it("silently ignores event() for unknown spanId", () => {
    // Should not throw
    telemetry.event("nonexistent-span" as SpanId, "ghost", { x: 1 });
  });

  it("silently ignores end() for unknown spanId", () => {
    // Should not throw, and no span should appear in exporter
    telemetry.end({ id: "nonexistent-span" as SpanId, endedAt: Date.now(), status: "ok" });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("tracks parent-child relationships via parent SpanId", () => {
    const parentId = "span-parent" as SpanId;
    const childId = "span-child" as SpanId;

    telemetry.start({ id: parentId, kind: "task", name: "parent", startedAt: Date.now() });
    telemetry.start({
      id: childId,
      kind: "agent_spawn",
      name: "child",
      parent: parentId,
      startedAt: Date.now(),
    });
    telemetry.end({ id: childId, endedAt: Date.now(), status: "ok" });
    telemetry.end({ id: parentId, endedAt: Date.now(), status: "ok" });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    // Child span should reference parent's span context
    const child = spans.find((s) => s.name === "child");
    const parent = spans.find((s) => s.name === "parent");
    expect(child).toBeDefined();
    expect(parent).toBeDefined();
    if (child && parent) {
      // The child's parentSpanId should match the parent's spanId
      expect(child.parentSpanId).toBe(parent.spanContext().spanId);
    }
  });

  it("coerces non-primitive event attrs to JSON strings", () => {
    telemetry.start({ id: spanId, kind: "bus_envelope", name: "x", startedAt: Date.now() });
    telemetry.event(spanId, "complex", { obj: { nested: true }, arr: [1, 2] });
    telemetry.end({ id: spanId, endedAt: Date.now(), status: "ok" });

    const span = exporter.getFinishedSpans()[0];
    expect(span).toBeDefined();
    if (!span) return;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(span.events[0]?.attributes?.["obj"]).toBe('{"nested":true}');
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(span.events[0]?.attributes?.["arr"]).toBe("[1,2]");
  });
});
