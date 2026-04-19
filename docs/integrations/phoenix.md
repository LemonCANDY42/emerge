# Phoenix integration guide

**Phoenix** (by Arize AI) is an open-source LLM observability platform you can
run locally. It speaks OpenTelemetry over OTLP HTTP — which means emerge sessions
appear as full distributed traces with no custom UI work.

---

## Prerequisites

- Docker Desktop running
- `emerge` project built (`pnpm build`)
- Node.js >= 20

---

## 1. Start Phoenix

```bash
docker run \
  --name phoenix \
  -p 6006:6006 \
  -p 4317:4317 \
  -d \
  arizephoenix/phoenix:latest
```

Phoenix exposes:
- `http://localhost:6006` — web UI
- `http://localhost:6006/v1/traces` — OTLP HTTP ingest endpoint

Verify it's running:

```bash
open http://localhost:6006
```

You should see the Phoenix dashboard (empty for now).

---

## 2. Wire OtelTelemetry into your kernel

Install the OTel dependencies for your project:

```bash
pnpm add @lwrf42/emerge-telemetry-otel @opentelemetry/api
pnpm add -D @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http \
            @opentelemetry/resources @opentelemetry/semantic-conventions
```

In your agent harness:

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { trace } from "@opentelemetry/api";
import { OtelTelemetry } from "@lwrf42/emerge-telemetry-otel";
import { Kernel } from "@lwrf42/emerge-kernel/runtime";

// 1. Start the OTel SDK before any kernel activity
const sdk = new NodeSDK({
  resource: new Resource({ [ATTR_SERVICE_NAME]: "my-emerge-app" }),
  traceExporter: new OTLPTraceExporter({
    url: "http://localhost:6006/v1/traces",
  }),
});
sdk.start();

// 2. Create a Tracer and wrap it in OtelTelemetry
const tracer = trace.getTracer("my-emerge-app");
const telemetry = new OtelTelemetry({ tracer, serviceName: "my-emerge-app" });

// 3. Pass telemetry to the Kernel
const kernel = new Kernel(
  {
    mode: "auto",
    reproducibility: "free",
    lineage: { maxDepth: 4 },
    bus: { bufferSize: 256 },
    roles: {},
    trustMode: "implicit",
  },
  { telemetry },
);

// ... spawn agents, run sessions as normal ...

// 4. Flush spans before exit
await sdk.shutdown();
```

---

## 3. What you will see in Phoenix

After running a session, open `http://localhost:6006` and navigate to the
**Traces** tab. You should see:

- **One trace per session**, labelled by the session ID.
- **`agent_spawn` spans** — v1 emits one span per agent spawned, with basic
  attributes (`emerge.agent.id`, `emerge.span.kind`).

> **v1 span coverage note:** v1 emits `agent_spawn` spans only. Full kernel
> span coverage (`provider_call`, `tool_call`, `bus_envelope`,
> `surveillance_assess`) is planned for M3d. If you see only one span per
> session that is expected behaviour — the wiring is correct, the data is just
> sparse at this milestone.

- **Error spans** for failed operations (status `ERROR` with `emerge.error.code`
  and `emerge.error.message` attributes).
- **Free-form events** from `telemetry.event()` visible under each span.

The attribute `emerge.span.kind` on every span tells you which kernel concept
it maps to. You can filter by it in Phoenix's span attribute explorer.

---

## 4. Run the built-in demo

```bash
# Start Phoenix first (step 1 above)
pnpm build
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006/v1/traces \
  node examples/otel-phoenix/dist/index.js
```

Expected output:
```
[otel-phoenix] Sending spans to: http://localhost:6006/v1/traces
[otel-phoenix] Agent run complete. Flushing spans to OTel collector...
[otel-phoenix] Done. Open your OTel sink to inspect the trace:
  Phoenix: http://localhost:6006 → Traces tab → search for service "emerge-otel-demo"
  Session ID: otel-demo-<timestamp>
```

---

## 5. Troubleshooting

**"Cannot connect to Phoenix"** — Docker may not be running. Run `docker ps` to
check. Restart with `docker start phoenix` if the container exists but is stopped.

**"No traces appearing"** — The OTel SDK batches spans. Make sure you call
`await sdk.shutdown()` at the end of your process — this flushes the batch
exporter. Without it, spans may not be sent before the process exits.

**"Port 6006 already in use"** — Another process is using the port.
Run `lsof -i :6006` to identify it. You can change Phoenix's port with:
```bash
docker run -p 6007:6006 arizephoenix/phoenix:latest
```
Then update your OTLP URL to `http://localhost:6007/v1/traces`.

**"Spans appear but attributes are missing"** — Make sure you are passing
`telemetry` to `KernelDeps`, not `undefined`. Check that the provider correctly
reports `usage` on its `stop` events (MockProvider always does; real providers
depend on the API response).

**Traces span multiple services** — If you run multiple kernel instances (e.g.
in a supervisor-worker topology), set `serviceName` to a distinct value per
kernel so Phoenix can distinguish them. W3C Trace Context is propagated via
`TraceContext` on bus envelopes, so parent-child relationships are preserved
across spawns.

---

## Further reading

- [Phoenix documentation](https://docs.arize.com/phoenix)
- [OpenTelemetry for Node.js](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/)
- [ARCHITECTURE.md — OTel section](../../ARCHITECTURE.md)
- `docs/adr/0037-jsonl-event-schema.md` — why we use OTel + JSONL together
