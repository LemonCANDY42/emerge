/**
 * @lwrf42/emerge-telemetry-otel — OpenTelemetry Telemetry implementation.
 *
 * Maps kernel spans → OTel spans:
 *   - SpanKind → OTel span name + `emerge.span.kind` attribute
 *   - BudgetUsage → `emerge.usage.*` attributes on SpanEnd
 *   - TraceContext on SpanStart → W3C Trace Context propagation via `propagation.extract()`
 *   - Errors → OTel SpanStatusCode.ERROR with code + message attributes
 *   - event() → span.addEvent(name, attrs)
 *
 * Design: the caller wires their own NodeSDK + Tracer and passes it in.
 * This package does NOT bundle the OTel SDK — keep users free to configure
 * their own exporter (OTLP HTTP, Jaeger, console, etc.).
 *
 * Peer dependency: @opentelemetry/api >=1.6.0
 */

import type { SpanEnd, SpanId, SpanStart, Telemetry } from "@lwrf42/emerge-kernel/contracts";
import {
  type Context,
  type Span,
  SpanStatusCode,
  type Tracer,
  context,
  propagation,
  trace,
} from "@opentelemetry/api";

export interface OtelTelemetryOptions {
  tracer: Tracer;
  /** Optional service name attribute added to all spans. Default: "emerge". */
  serviceName?: string;
}

/**
 * OtelTelemetry implements the Telemetry contract by forwarding kernel spans
 * to an OpenTelemetry Tracer.
 *
 * Active spans are tracked by SpanId in an internal Map so `event()` and `end()`
 * can look them up without the caller needing to thread span objects.
 */
export class OtelTelemetry implements Telemetry {
  private readonly tracer: Tracer;
  private readonly serviceName: string;
  private readonly activeSpans = new Map<string, Span>();
  private readonly activeContexts = new Map<string, Context>();

  constructor(opts: OtelTelemetryOptions) {
    this.tracer = opts.tracer;
    this.serviceName = opts.serviceName ?? "emerge";
  }

  start(span: SpanStart): void {
    // Resolve parent context: use W3C Trace Context if provided, else check
    // if there is a parent SpanId already tracked in our map.
    let parentCtx: Context = context.active();

    if (span.traceContext) {
      // Extract W3C traceparent / tracestate into an OTel context
      parentCtx = propagation.extract(context.active(), {
        traceparent: span.traceContext.traceparent,
        ...(span.traceContext.tracestate !== undefined
          ? { tracestate: span.traceContext.tracestate }
          : {}),
      });
    } else if (span.parent) {
      // Use the parent span's context if we have it tracked
      const parentSpanCtx = this.activeContexts.get(span.parent as string);
      if (parentSpanCtx !== undefined) {
        parentCtx = parentSpanCtx;
      }
    }

    const otelSpan = this.tracer.startSpan(
      span.name,
      {
        startTime: span.startedAt,
        attributes: {
          "emerge.span.kind": span.kind,
          "emerge.service": this.serviceName,
          ...(span.agent !== undefined ? { "emerge.agent.id": span.agent as string } : {}),
          ...(span.task !== undefined ? { "emerge.task.id": span.task as string } : {}),
          ...(span.attributes ?? {}),
        },
      },
      parentCtx,
    );

    const spanCtx = trace.setSpan(parentCtx, otelSpan);
    this.activeSpans.set(span.id as string, otelSpan);
    this.activeContexts.set(span.id as string, spanCtx);
  }

  end(span: SpanEnd): void {
    const otelSpan = this.activeSpans.get(span.id as string);
    if (!otelSpan) return;

    if (span.status === "error") {
      otelSpan.setStatus({
        code: SpanStatusCode.ERROR,
        ...(span.error?.message !== undefined ? { message: span.error.message } : {}),
      });
      if (span.error) {
        otelSpan.setAttribute("emerge.error.code", span.error.code);
        otelSpan.setAttribute("emerge.error.message", span.error.message);
      }
    } else {
      otelSpan.setStatus({ code: SpanStatusCode.OK });
    }

    if (span.usage) {
      otelSpan.setAttribute("emerge.usage.tokensIn", span.usage.tokensIn);
      otelSpan.setAttribute("emerge.usage.tokensOut", span.usage.tokensOut);
      otelSpan.setAttribute("emerge.usage.wallMs", span.usage.wallMs);
      otelSpan.setAttribute("emerge.usage.toolCalls", span.usage.toolCalls);
      otelSpan.setAttribute("emerge.usage.usd", span.usage.usd);
    }

    otelSpan.end(span.endedAt);

    this.activeSpans.delete(span.id as string);
    this.activeContexts.delete(span.id as string);
  }

  event(spanId: SpanId, name: string, attrs?: Readonly<Record<string, unknown>>): void {
    const otelSpan = this.activeSpans.get(spanId as string);
    if (!otelSpan) return;

    // OTel addEvent accepts Record<string, AttributeValue>; we coerce unknown → string
    // for values that are not natively supported. This is safe for observability.
    const otelAttrs: Record<string, string | number | boolean> = {};
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          otelAttrs[k] = v;
        } else {
          otelAttrs[k] = JSON.stringify(v);
        }
      }
    }

    otelSpan.addEvent(name, otelAttrs);
  }
}
