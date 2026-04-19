# @emerge/telemetry-otel

OpenTelemetry exporter for the emerge agent harness — compatible with Phoenix, Langfuse, Jaeger, and any W3C Trace Context-compatible OTel sink.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install @emerge/telemetry-otel
npm install @opentelemetry/api  # peer dependency
```

## Quick example

```ts
import { OtelTelemetry } from "@emerge/telemetry-otel";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("emerge");
const telemetry = new OtelTelemetry({ tracer });

const kernel = new Kernel({ telemetry, provider });
await kernel.startSession();
// ... spans emitted to your configured OTel exporter ...
await kernel.endSession();
```

## Peer dependency

`@opentelemetry/api >= 1.6.0` must be installed by your application. This package does not bundle OTel to avoid version conflicts.

## Compatible sinks

- [Arize Phoenix](https://phoenix.arize.com/)
- [Langfuse](https://langfuse.com/)
- [Jaeger](https://www.jaegertracing.io/)
- Any OpenTelemetry-compatible collector

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
