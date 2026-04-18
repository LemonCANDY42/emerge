# Langfuse integration guide

**Langfuse** is an open-source LLM observability and evaluation platform
available as a managed cloud service or self-hosted. Its OTLP-compatible
tracing endpoint accepts emerge spans with no additional configuration.

---

## Prerequisites

- A Langfuse account at [cloud.langfuse.com](https://cloud.langfuse.com) **or**
  a self-hosted Langfuse instance
- `emerge` project built (`pnpm build`)
- Node.js >= 20

---

## 1. Get your credentials

### Cloud (langfuse.com)

1. Sign in at [cloud.langfuse.com](https://cloud.langfuse.com).
2. Create a project.
3. Go to **Settings → API Keys** and create a key pair.
4. Note your **Public Key** (`pk-...`) and **Secret Key** (`sk-...`).
5. Base64-encode them as `pk-xxx:sk-xxx`:
   ```bash
   echo -n "pk-xxx:sk-xxx" | base64
   # → cGstenN ...
   ```
6. Your OTLP endpoint is `https://cloud.langfuse.com/api/public/otel/v1/traces`.

### Self-hosted

If you host Langfuse yourself (via Docker Compose):
```bash
# https://langfuse.com/docs/deployment/local
git clone https://github.com/langfuse/langfuse.git
cd langfuse
docker compose up -d
```
Your OTLP endpoint will be `http://localhost:3000/api/public/otel/v1/traces`.
Generate API keys from the Langfuse admin UI at `http://localhost:3000`.

---

## 2. Wire OtelTelemetry into your kernel

Install the OTel dependencies for your project:

```bash
pnpm add @emerge/telemetry-otel @opentelemetry/api
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
import { OtelTelemetry } from "@emerge/telemetry-otel";
import { Kernel } from "@emerge/kernel/runtime";

const LANGFUSE_ENDPOINT = "https://cloud.langfuse.com/api/public/otel/v1/traces";
const LANGFUSE_AUTH = Buffer.from("pk-xxx:sk-xxx").toString("base64");

const sdk = new NodeSDK({
  resource: new Resource({ [ATTR_SERVICE_NAME]: "my-emerge-app" }),
  traceExporter: new OTLPTraceExporter({
    url: LANGFUSE_ENDPOINT,
    headers: {
      Authorization: `Basic ${LANGFUSE_AUTH}`,
    },
  }),
});
sdk.start();

const tracer = trace.getTracer("my-emerge-app");
const telemetry = new OtelTelemetry({ tracer, serviceName: "my-emerge-app" });

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

// ... spawn agents, run sessions ...

await sdk.shutdown();
```

---

## 3. Run the demo with Langfuse

The `examples/otel-phoenix` demo supports Langfuse via environment variables.
Phoenix and Langfuse both speak OTLP HTTP, so the same demo works for both:

```bash
pnpm build

# Cloud Langfuse
OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic cGstenN..." \
  node examples/otel-phoenix/dist/index.js

# Self-hosted Langfuse
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/api/public/otel/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic cGstenN..." \
  node examples/otel-phoenix/dist/index.js
```

The `OTEL_EXPORTER_OTLP_HEADERS` variable accepts comma-separated `Key=Value`
pairs (e.g. `"Authorization=Basic xxx,X-Custom-Header=value"`).

---

## 4. What you will see in Langfuse

After running a session, open the Langfuse UI and navigate to **Traces**.
You should see:

- **One trace per emerge session**, with the session ID as the trace name.
- **`agent_spawn` spans** — v1 emits one span per agent spawned, with basic
  attributes (`emerge.agent.id`, `emerge.span.kind`).

> **v1 span coverage note:** v1 emits `agent_spawn` spans only. Full kernel
> span coverage (`provider_call`, `tool_call`, `bus_envelope`,
> `surveillance_assess`) is planned for M3d. If you see only one span per
> session that is expected behaviour — the wiring is correct, the data is just
> sparse at this milestone. Token + cost attributes will appear on `provider_call`
> spans once M3d ships.

- **Error spans** with `emerge.error.code` and `emerge.error.message` for
  failed operations.
- **Free-form events** (from `telemetry.event()`) visible in the span timeline.

Langfuse's **Evaluations** tab can be used to score emerge sessions post-hoc
if you export the session JSONL and submit evaluations via the Langfuse SDK.

---

## 5. Troubleshooting

**"401 Unauthorized"** — The `Authorization` header is malformed. Double-check
the base64 encoding of `pk-xxx:sk-xxx`. Note the colon between public and
secret key. Test with:
```bash
echo -n "pk-xxx:sk-xxx" | base64
```

**"No traces appearing after a few minutes"** — The OTel SDK batches spans
with a default flush interval. Always call `await sdk.shutdown()` at process
exit. Without this, spans may be buffered but not sent.

**"Traces appear but are unnamed"** — Set a meaningful `serviceName` in
`OtelTelemetryOptions`. This becomes the Langfuse trace name.

**"Self-hosted: connection refused"** — Confirm Langfuse is running:
```bash
docker compose ps  # in the langfuse directory
```
Check that port 3000 is accessible: `curl http://localhost:3000/health`.

**"CORS error in browser"** — The OTel SDK runs server-side (Node.js); CORS
doesn't apply. If you see this, you're likely running client-side code — use
the Node.js SDK only in server contexts.

---

## Attribute reference

| OTel attribute | emerge meaning |
|---|---|
| `emerge.span.kind` | Which kernel concept this span represents |
| `emerge.service` | Service name (from `OtelTelemetryOptions.serviceName`) |
| `emerge.agent.id` | Agent ID that originated this span |
| `emerge.task.id` | Task ID if present on `SpanStart` |
| `emerge.usage.tokensIn` | Input tokens consumed |
| `emerge.usage.tokensOut` | Output tokens produced |
| `emerge.usage.usd` | Estimated cost in USD |
| `emerge.usage.wallMs` | Wall-clock duration in milliseconds |
| `emerge.usage.toolCalls` | Number of tool calls in this step |
| `emerge.error.code` | Structured error code (on error spans) |
| `emerge.error.message` | Human-readable error message (on error spans) |

---

## Further reading

- [Langfuse documentation](https://langfuse.com/docs)
- [Langfuse OTLP integration](https://langfuse.com/docs/integrations/opentelemetry)
- [Phoenix integration guide](./phoenix.md) — for self-hosted, zero-signup alternative
- `docs/adr/0037-jsonl-event-schema.md` — the JSONL schema that feeds OTel
