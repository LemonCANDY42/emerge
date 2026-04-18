/**
 * agent-runner.inbox.test.ts
 *
 * C1/C2: Verifies that the inbox subscription is opened BEFORE Kernel.spawn() returns,
 * so a bus.send(request) fired BEFORE kernel.runAgent() is never missed.
 *
 * Without the fix, the subscription was opened inside run(), which meant any
 * bus.send() between spawn() and runAgent() would be lost — the request would
 * arrive before the subscription existed, fan-out would find no matching subscriber,
 * and the agent would never see the payload.
 */

import { describe, expect, it } from "vitest";
import type {
  AgentId,
  CorrelationId,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  Result,
  SessionId,
} from "../contracts/index.js";
import { Kernel } from "./kernel.js";

function agentId(s: string): AgentId {
  return s as AgentId;
}
function sessId(s: string): SessionId {
  return s as SessionId;
}
function corrId(s: string): CorrelationId {
  return s as CorrelationId;
}

/** Provider that captures each invocation's messages for later inspection. */
function makeCaptureProvider(id: string): {
  readonly capabilities: { id: string; claimed: Record<string, unknown> };
  invoke: (req: ProviderRequest) => AsyncGenerator<ProviderEvent>;
  countTokens: (_: readonly ProviderMessage[]) => Promise<Result<number>>;
  calls: ProviderMessage[][];
} {
  const calls: ProviderMessage[][] = [];
  const capabilities = {
    id,
    claimed: {
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      nativeToolUse: false,
      streamingToolUse: false,
      vision: false,
      audio: false,
      thinking: false,
      latencyTier: "interactive" as const,
    },
  };

  return {
    capabilities,
    calls,
    async *invoke(req: ProviderRequest): AsyncGenerator<ProviderEvent> {
      calls.push([...req.messages]);
      yield { type: "text_delta", text: "ok" };
      yield {
        type: "stop",
        reason: "end_turn",
        usage: { tokensIn: 5, tokensOut: 2, wallMs: 1, toolCalls: 0, usd: 0 },
      };
    },
    async countTokens(_messages: readonly ProviderMessage[]): Promise<Result<number>> {
      return { ok: true, value: 10 };
    },
  };
}

function makeSpec(id: AgentId) {
  return {
    id,
    role: "worker",
    description: "inbox test agent",
    provider: { kind: "static" as const, providerId: "capture-provider" },
    system: { kind: "literal" as const, text: "You are a test agent." },
    toolsAllowed: [] as string[],
    memoryView: { inheritFromSupervisor: false, writeTags: [] as string[] },
    budget: { tokensIn: 10_000, tokensOut: 2000 },
    termination: {
      maxIterations: 3,
      maxWallMs: 10_000,
      budget: { tokensIn: 10_000, tokensOut: 2000 },
      retry: { transient: 0, nonRetryable: 0 as const },
      cycle: { windowSize: 5, repeatThreshold: 3 },
      done: { kind: "predicate" as const, description: "end_turn" },
    },
    acl: {
      acceptsRequests: "any" as const,
      acceptsQueries: "any" as const,
      acceptsSignals: "any" as const,
      acceptsNotifications: "any" as const,
    },
    capabilities: {
      tools: [] as string[],
      modalities: ["text" as const],
      qualityTier: "standard" as const,
      streaming: false,
      interrupts: false,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
    surveillance: "off" as const,
  };
}

describe("C1/C2: inbox subscribe-before-send guarantee", () => {
  it("receives a request payload sent BEFORE runAgent() is called", async () => {
    const provider = makeCaptureProvider("capture-provider");
    const kernel = new Kernel(
      {
        mode: "auto",
        reproducibility: "free",
        lineage: { maxDepth: 4 },
        bus: { bufferSize: 256 },
        roles: {},
        trustMode: "implicit",
      },
      {},
    );
    kernel.mountProvider(provider as unknown as Parameters<typeof kernel.mountProvider>[0]);

    const sessionId = sessId(`inbox-test-${Date.now()}`);
    kernel.setSession(sessionId, "test-contract" as never);

    const spec = makeSpec(agentId("inbox-agent"));
    const spawnResult = await kernel.spawn(spec);
    expect(spawnResult.ok).toBe(true);
    if (!spawnResult.ok) return;

    const handle = spawnResult.value;
    const bus = kernel.getBus();

    // KEY: send the request AFTER spawn() but BEFORE runAgent().
    // The inbox subscription must already exist at this point.
    const requestPayload = { task: "hello from bus before run" };
    const sendResult = await bus.send({
      kind: "request",
      correlationId: corrId("test-req-1"),
      sessionId,
      from: agentId("test-sender"),
      to: { kind: "agent", id: handle.id },
      timestamp: Date.now(),
      payload: requestPayload,
    });
    expect(sendResult.ok).toBe(true);

    // Now run the agent — it should drain the inbox queue on first iteration.
    await kernel.runAgent(handle);

    // The provider should have been called at least once.
    expect(provider.calls.length).toBeGreaterThanOrEqual(1);

    // The last provider call's messages should include the payload text injected from inbox.
    const allMessages = provider.calls.flat();
    const payloadText = JSON.stringify(requestPayload);
    const foundPayload = allMessages.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((c) => c.type === "text" && c.text.includes("hello from bus before run")),
    );
    expect(foundPayload).toBe(true);
  }, 10_000);

  it("receives multiple requests queued before runAgent()", async () => {
    const provider = makeCaptureProvider("capture-provider");
    const kernel = new Kernel(
      {
        mode: "auto",
        reproducibility: "free",
        lineage: { maxDepth: 4 },
        bus: { bufferSize: 256 },
        roles: {},
        trustMode: "implicit",
      },
      {},
    );
    kernel.mountProvider(provider as unknown as Parameters<typeof kernel.mountProvider>[0]);

    const sessionId = sessId(`inbox-multi-${Date.now()}`);
    kernel.setSession(sessionId, "test-contract" as never);

    const spec = makeSpec(agentId("inbox-multi-agent"));
    const spawnResult = await kernel.spawn(spec);
    expect(spawnResult.ok).toBe(true);
    if (!spawnResult.ok) return;

    const handle = spawnResult.value;
    const bus = kernel.getBus();

    // Send two requests before running
    await bus.send({
      kind: "request",
      correlationId: corrId("req-A"),
      sessionId,
      from: agentId("sender"),
      to: { kind: "agent", id: handle.id },
      timestamp: Date.now(),
      payload: "payload-alpha",
    });
    await bus.send({
      kind: "request",
      correlationId: corrId("req-B"),
      sessionId,
      from: agentId("sender"),
      to: { kind: "agent", id: handle.id },
      timestamp: Date.now(),
      payload: "payload-beta",
    });

    await kernel.runAgent(handle);

    const allMessages = provider.calls.flat();
    const foundAlpha = allMessages.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((c) => c.type === "text" && c.text.includes("payload-alpha")),
    );
    const foundBeta = allMessages.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((c) => c.type === "text" && c.text.includes("payload-beta")),
    );
    expect(foundAlpha).toBe(true);
    expect(foundBeta).toBe(true);
  }, 10_000);
});
