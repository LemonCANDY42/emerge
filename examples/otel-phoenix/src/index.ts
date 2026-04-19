/**
 * otel-phoenix demo — emit emerge spans to Phoenix (open-source LLM observability).
 *
 * Skip-mode: if OTEL_EXPORTER_OTLP_ENDPOINT is unset, exits 0 with a clear
 * "skipped" message. To run against Phoenix:
 *
 *   docker run -p 6006:6006 arizephoenix/phoenix:latest
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006/v1/traces node dist/index.js
 *
 * Or against Langfuse:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel/v1/traces \
 *   OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64 pk:sk>" \
 *   node dist/index.js
 *
 * See docs/integrations/phoenix.md and docs/integrations/langfuse.md.
 */

import type { AgentId, ProviderEvent, SessionId } from "@lwrf42/emerge-kernel/contracts";
import { Kernel } from "@lwrf42/emerge-kernel/runtime";
import { MockProvider } from "@lwrf42/emerge-provider-mock";
import { OtelTelemetry } from "@lwrf42/emerge-telemetry-otel";

// biome-ignore lint/complexity/useLiteralKeys: env var names contain underscores, bracket notation is clearer
const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
// biome-ignore lint/complexity/useLiteralKeys: env var names contain underscores, bracket notation is clearer
const headers = process.env["OTEL_EXPORTER_OTLP_HEADERS"];

if (!endpoint) {
  console.log("[otel-phoenix] OTEL_EXPORTER_OTLP_ENDPOINT is not set — skipping.");
  console.log("");
  console.log("To run this demo against Phoenix:");
  console.log("  docker run -p 6006:6006 arizephoenix/phoenix:latest");
  console.log("  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006/v1/traces node dist/index.js");
  console.log("");
  console.log("To run against Langfuse cloud:");
  console.log(
    "  OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel/v1/traces \\",
  );
  console.log('  OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64 pk:sk>" \\');
  console.log("  node dist/index.js");
  process.exit(0);
}

async function main(): Promise<void> {
  // Dynamic import so the module can load even when OTel SDK packages are not
  // installed (the skip-mode above exits before we reach this point).
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  const { Resource } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions");
  const { trace } = await import("@opentelemetry/api");

  // Parse optional headers from OTEL_EXPORTER_OTLP_HEADERS ("Key=Value,Key=Value")
  const parsedHeaders: Record<string, string> = {};
  if (headers) {
    for (const pair of headers.split(",")) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx > 0) {
        parsedHeaders[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
      }
    }
  }

  const exporter = new OTLPTraceExporter({ url: endpoint as string, headers: parsedHeaders });

  const sdk = new NodeSDK({
    resource: new Resource({ [ATTR_SERVICE_NAME]: "emerge-otel-demo" }),
    traceExporter: exporter,
  });

  sdk.start();

  const tracer = trace.getTracer("emerge-otel-phoenix-demo");
  const telemetry = new OtelTelemetry({ tracer, serviceName: "emerge-otel-demo" });

  console.log(`[otel-phoenix] Sending spans to: ${endpoint}`);

  const script: { events: readonly ProviderEvent[] }[] = [
    {
      events: [
        { type: "text_delta", text: "Thinking about the task..." },
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 50, tokensOut: 20, wallMs: 150, toolCalls: 0, usd: 0.001 },
        },
      ],
    },
  ];

  const provider = new MockProvider(script, "mock");

  const kernel = new Kernel(
    {
      mode: "auto",
      reproducibility: "free",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 128 },
      roles: {},
      trustMode: "implicit",
    },
    { telemetry },
  );

  kernel.mountProvider(provider);

  const sessionId = `otel-demo-${Date.now()}` as SessionId;
  kernel.setSession(sessionId, "otel-demo-contract" as never);

  const agentId = "otel-demo-agent" as AgentId;
  const spawnResult = await kernel.spawn({
    id: agentId,
    role: "demo",
    description: "OTel Phoenix demo agent",
    provider: { kind: "static", providerId: "mock" },
    system: { kind: "literal", text: "You are a demo agent for OTel tracing." },
    toolsAllowed: [],
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    budget: { tokensIn: 1_000, tokensOut: 500, usd: 0.1 },
    termination: {
      maxIterations: 3,
      maxWallMs: 30_000,
      budget: { tokensIn: 1_000, tokensOut: 500 },
      retry: { transient: 1, nonRetryable: 0 },
      cycle: { windowSize: 5, repeatThreshold: 3 },
      done: { kind: "predicate", description: "end_turn" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: [],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: true,
      interrupts: false,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
  });

  if (!spawnResult.ok) {
    console.error("[otel-phoenix] Failed to spawn agent:", spawnResult.error);
    await sdk.shutdown();
    process.exit(1);
  }

  await kernel.runAgent(spawnResult.value);
  await kernel.endSession();

  console.log("[otel-phoenix] Agent run complete. Flushing spans to OTel collector...");

  await sdk.shutdown();

  console.log("[otel-phoenix] Done. Open your OTel sink to inspect the trace:");
  console.log(
    `  Phoenix: http://localhost:6006 → Traces tab → search for service "emerge-otel-demo"`,
  );
  console.log(`  Session ID: ${String(sessionId)}`);
}

main().catch((err: unknown) => {
  console.error("[otel-phoenix] Error:", err);
  process.exit(1);
});
