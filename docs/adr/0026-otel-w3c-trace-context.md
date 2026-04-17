# ADR 0026 — OTel + W3C Trace Context end-to-end

**Status:** accepted
**Date:** 2026-04-17

## Context

Multi-agent topologies — especially nested ones — are unobservable
without correlated tracing. W3C Trace Context is the cross-vendor
standard; OpenTelemetry is the cross-vendor exporter.

Picking either today and "adding the other later" is the path to two
incompatible models.

## Decision

- `TraceContext { traceparent, tracestate? }` is a kernel primitive.
- `SpanStart` carries an optional `traceContext`.
- Bus envelopes carry an optional `traceContext`.
- Sub-agent spawns inherit the parent's trace context.
- The default telemetry implementation can export to any OTel collector;
  LangSmith / Langfuse / etc. are downstream wrappers.

## Alternatives considered

- **Custom span format.** Rejected: forces every consumer to adapt.
- **OTel only.** Rejected: trace context propagation is a separate
  concern from where spans are sent.

## Consequences

- Every spawn / envelope is traceable end-to-end.
- The cost is a few extra bytes per envelope.
