/**
 * supervisor-worker.llm-aggregation.test.ts
 *
 * C1/C2: Verifies that when no aggregator/reducer is provided, the supervisorWorker
 * topology correctly dispatches an aggregation prompt to the supervisor agent via
 * bus — and the prompt contains all worker outputs.
 *
 * Without the C1/C2 inbox fix, the aggregation request would be sent to the
 * supervisor BEFORE the supervisor's inbox subscription existed (it was opened
 * inside run()). The supervisor would never see the payload and the aggregation
 * step would produce an empty response.
 */

import type {
  AgentHandle,
  AgentId,
  AgentSpec,
  CorrelationId,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  Result,
  SessionId,
  ToolName,
} from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { describe, expect, it } from "vitest";
import { supervisorWorker } from "./supervisor-worker.js";

function agentId(s: string): AgentId {
  return s as AgentId;
}
function sessId(s: string): SessionId {
  return s as SessionId;
}

function makeCapturingProvider(id: string, replyText: string) {
  const capturedMessages: ProviderMessage[][] = [];

  const provider = {
    capabilities: {
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
    },
    capturedMessages,
    async *invoke(req: ProviderRequest): AsyncGenerator<ProviderEvent> {
      capturedMessages.push([...req.messages]);
      yield { type: "text_delta", text: replyText };
      yield {
        type: "stop",
        reason: "end_turn",
        usage: { tokensIn: 10, tokensOut: replyText.length, wallMs: 1, toolCalls: 0, usd: 0 },
      };
    },
    async countTokens(_: readonly ProviderMessage[]): Promise<Result<number>> {
      return { ok: true, value: 5 };
    },
  };
  return provider;
}

function makeWorkerProvider(id: string, output: string) {
  return {
    capabilities: {
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
    },
    async *invoke(req: ProviderRequest): AsyncGenerator<ProviderEvent> {
      if (req.signal?.aborted) return;
      yield { type: "text_delta", text: output };
      yield {
        type: "stop",
        reason: "end_turn",
        usage: { tokensIn: 5, tokensOut: output.length, wallMs: 1, toolCalls: 0, usd: 0 },
      };
    },
    async countTokens(_: readonly ProviderMessage[]): Promise<Result<number>> {
      return { ok: true, value: 5 };
    },
  };
}

function makeSpec(id: string, providerId: string): AgentSpec {
  return {
    id: agentId(id),
    role: id.startsWith("sup") ? "supervisor" : "worker",
    description: `${id} agent`,
    provider: { kind: "static" as const, providerId },
    system: { kind: "literal" as const, text: `You are ${id}` },
    toolsAllowed: [] as unknown as readonly ToolName[],
    memoryView: { inheritFromSupervisor: false, writeTags: [], readFilter: {} },
    budget: { tokensOut: 1000 },
    termination: {
      maxIterations: 3,
      maxWallMs: 10_000,
      budget: {},
      retry: { transient: 0, nonRetryable: 0 as const },
      cycle: { windowSize: 3, repeatThreshold: 3 },
      done: { kind: "predicate" as const, description: "done" },
    },
    acl: {
      acceptsRequests: "any" as const,
      acceptsQueries: "any" as const,
      acceptsSignals: "any" as const,
      acceptsNotifications: "any" as const,
    },
    capabilities: {
      tools: [],
      modalities: ["text" as const],
      qualityTier: "standard" as const,
      streaming: false,
      interrupts: false,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
    surveillance: "passive" as const,
  };
}

describe("C1/C2: supervisorWorker LLM aggregation — inbox fix", () => {
  it("aggregation prompt reaches supervisor and contains all worker outputs", async () => {
    const workerAOutput = "Worker A result: apple";
    const workerBOutput = "Worker B result: banana";

    const workerAProvider = makeWorkerProvider("worker-a-provider", workerAOutput);
    const workerBProvider = makeWorkerProvider("worker-b-provider", workerBOutput);

    const supervisorReply = `Combined: ${workerAOutput} and ${workerBOutput}`;
    const supervisorProvider = makeCapturingProvider("supervisor-provider", supervisorReply);

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

    kernel.mountProvider(workerAProvider as Parameters<typeof kernel.mountProvider>[0]);
    kernel.mountProvider(workerBProvider as Parameters<typeof kernel.mountProvider>[0]);
    kernel.mountProvider(supervisorProvider as Parameters<typeof kernel.mountProvider>[0]);

    const sessionId = sessId(`sw-agg-test-${Date.now()}`);
    kernel.setSession(sessionId, "test-contract" as never);

    const supervisorSpec = makeSpec("supervisor", "supervisor-provider");
    const workerASpec = makeSpec("worker-a", "worker-a-provider");
    const workerBSpec = makeSpec("worker-b", "worker-b-provider");

    // No aggregator — use LLM aggregation path
    const topologyResult = supervisorWorker({
      supervisor: supervisorSpec,
      workers: [workerASpec, workerBSpec],
      dispatch: "sequential",
      decomposer: (_input) => [
        { id: "task-a", payload: "task for worker A" },
        { id: "task-b", payload: "task for worker B" },
      ],
    });

    expect(topologyResult.ok).toBe(true);
    if (!topologyResult.ok) return;

    const kernelLike = kernel as {
      spawn(spec: AgentSpec): Promise<Result<AgentHandle>>;
      runAgent(handle: AgentHandle): Promise<void>;
      getBus(): import("@emerge/kernel/contracts").Bus;
    };

    const runResult = await topologyResult.value.run("test input", kernelLike, sessionId);

    expect(runResult.ok).toBe(true);

    // C1/C2: the supervisor's provider must have been called for the aggregation step.
    expect(supervisorProvider.capturedMessages.length).toBeGreaterThanOrEqual(1);

    // The aggregation prompt sent to the supervisor must contain both worker outputs.
    const aggregationCall = supervisorProvider.capturedMessages.at(-1);
    expect(aggregationCall).toBeDefined();

    const allText = (aggregationCall ?? [])
      .map((m) => {
        if (typeof m.content === "string") return m.content;
        return m.content
          .filter((c) => c.type === "text")
          .map((c) => (c.type === "text" ? c.text : ""))
          .join(" ");
      })
      .join(" ");

    expect(allText).toContain(workerAOutput);
    expect(allText).toContain(workerBOutput);

    // The final result should contain the supervisor's combined text
    if (runResult.ok) {
      const value = runResult.value as { text?: string };
      expect(
        typeof value === "object" && "text" in value ? value.text : JSON.stringify(value),
      ).toContain("Combined");
    }
  }, 15_000);

  it("falls back to JS aggregator when reducer is provided (backward-compat)", async () => {
    const workerProvider = makeWorkerProvider("worker-bc-provider", "worker output");
    const supervisorProvider = makeCapturingProvider("supervisor-bc-provider", "sup output");

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

    kernel.mountProvider(workerProvider as Parameters<typeof kernel.mountProvider>[0]);
    kernel.mountProvider(supervisorProvider as Parameters<typeof kernel.mountProvider>[0]);

    const sessionId = sessId(`sw-reducer-${Date.now()}`);
    kernel.setSession(sessionId, "test-contract" as never);

    const supervisorSpec = makeSpec("supervisor-bc", "supervisor-bc-provider");
    const workerSpec = makeSpec("worker-bc", "worker-bc-provider");

    // With reducer: JS aggregation fires instead of LLM aggregation
    let reducerCalled = false;
    const topologyResult = supervisorWorker({
      supervisor: supervisorSpec,
      workers: [workerSpec],
      dispatch: "sequential",
      reducer: (results) => {
        reducerCalled = true;
        return { combined: results };
      },
    });

    expect(topologyResult.ok).toBe(true);
    if (!topologyResult.ok) return;

    const kernelLike = kernel as {
      spawn(spec: AgentSpec): Promise<Result<AgentHandle>>;
      runAgent(handle: AgentHandle): Promise<void>;
      getBus(): import("@emerge/kernel/contracts").Bus;
    };

    await topologyResult.value.run("test input", kernelLike, sessionId);

    // Reducer was called — supervisor NOT invoked for aggregation (0 supervisor calls)
    expect(reducerCalled).toBe(true);
    expect(supervisorProvider.capturedMessages.length).toBe(0);
  }, 15_000);
});
