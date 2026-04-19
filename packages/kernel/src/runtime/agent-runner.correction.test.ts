/**
 * Integration test: agent-runner applies correctToolCall before dispatching
 * a tool call (ADR 0034).
 *
 * The test pattern mirrors agent-runner.verification.test.ts: a scripted
 * mock provider emits a tool call whose input has a type error ({count: "5"}
 * for a tool whose spec says count: number). We assert the tool received
 * 5 (number) not "5" (string), proving the correction layer fired.
 */

import { describe, expect, it } from "vitest";
import type {
  AgentId,
  ContractError,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  Result,
  SessionId,
  Tool,
  ToolInvocation,
  ToolResult,
} from "../contracts/index.js";
import { Kernel } from "./kernel.js";

// ---------------------------------------------------------------------------
// Helpers (same pattern as agent-runner.verification.test.ts)
// ---------------------------------------------------------------------------

function agentId(s: string): AgentId {
  return s as AgentId;
}
function sessId(s: string): SessionId {
  return s as SessionId;
}

function makeSpec(id: AgentId) {
  return {
    id,
    role: "worker",
    description: "correction test agent",
    provider: { kind: "static" as const, providerId: "mock" },
    system: { kind: "literal" as const, text: "You are a test agent." },
    toolsAllowed: ["counted-action"] as string[],
    memoryView: { inheritFromSupervisor: false, writeTags: [] as string[] },
    budget: { tokensIn: 10_000, tokensOut: 2000, usd: 1.0 },
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
      tools: ["counted-action"] as string[],
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

function makeScriptedProvider(
  id: string,
  scripts: ReadonlyArray<ReadonlyArray<ProviderEvent>>,
): Provider & { callCount: number } {
  let callIndex = 0;
  const capabilities: ProviderCapabilities = {
    id,
    claimed: {
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      nativeToolUse: true,
      streamingToolUse: false,
      vision: false,
      audio: false,
      thinking: false,
      latencyTier: "interactive",
    },
  };

  return {
    callCount: 0,
    capabilities,
    async *invoke(req: ProviderRequest): AsyncGenerator<ProviderEvent> {
      const script = scripts[callIndex % scripts.length];
      callIndex++;
      (this as { callCount: number }).callCount = callIndex;
      if (!script) {
        yield {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
        };
        return;
      }
      for (const event of script) {
        if (req.signal?.aborted) return;
        yield event;
      }
      const hasStop = script.some((e) => e.type === "stop" || e.type === "error");
      if (!hasStop) {
        yield {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 10, tokensOut: 5, wallMs: 10, toolCalls: 0, usd: 0.001 },
        };
      }
    },
    async countTokens(_messages: readonly ProviderMessage[]): Promise<Result<number>> {
      return { ok: true, value: 10 };
    },
  };
}

// ---------------------------------------------------------------------------
// The test tool: records the input it received
// ---------------------------------------------------------------------------

function makeCountedActionTool(received: { input: unknown }[]): Tool {
  return {
    spec: {
      name: "counted-action",
      description: "A tool that accepts a number count.",
      inputSchema: {
        "~standard": { version: 1, vendor: "test", validate: (v) => ({ value: v }) },
      },
      // jsonSchema is what the correction layer reads.
      jsonSchema: {
        type: "object",
        properties: {
          count: { type: "number" },
        },
        required: ["count"],
      },
      permission: {
        rationale: "test",
        effects: ["state_read"],
        defaultMode: "auto",
      },
    },
    async invoke(call: ToolInvocation): Promise<Result<ToolResult, ContractError>> {
      received.push({ input: call.input });
      return {
        ok: true,
        value: { ok: true, preview: "done" },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Provider script: emits a tool call with {count: "5"} (string, not number)
// then after the tool result, ends the turn.
// ---------------------------------------------------------------------------

const TOOL_CALL_SCRIPT: ReadonlyArray<ProviderEvent> = [
  {
    type: "tool_call_start",
    toolCallId: "tc-correction-1",
    name: "counted-action",
  },
  {
    type: "tool_call_input_delta",
    toolCallId: "tc-correction-1",
    partial: JSON.stringify({ count: "5" }), // string "5", not number 5
  },
  { type: "tool_call_end", toolCallId: "tc-correction-1" },
];

const FINISH_SCRIPT: ReadonlyArray<ProviderEvent> = [
  { type: "text_delta", text: "done" },
  {
    type: "stop",
    reason: "end_turn",
    usage: { tokensIn: 10, tokensOut: 5, wallMs: 10, toolCalls: 1, usd: 0.001 },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper: captures all requests sent to the provider
// ---------------------------------------------------------------------------

function makeCapturingProvider(
  id: string,
  scripts: ReadonlyArray<ReadonlyArray<ProviderEvent>>,
): Provider & { callCount: number; capturedRequests: ProviderRequest[] } {
  let callIndex = 0;
  const capturedRequests: ProviderRequest[] = [];
  const capabilities: ProviderCapabilities = {
    id,
    claimed: {
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      nativeToolUse: true,
      streamingToolUse: false,
      vision: false,
      audio: false,
      thinking: false,
      latencyTier: "interactive",
    },
  };

  return {
    callCount: 0,
    capturedRequests,
    capabilities,
    async *invoke(req: ProviderRequest): AsyncGenerator<ProviderEvent> {
      capturedRequests.push(req);
      const script = scripts[callIndex % scripts.length];
      callIndex++;
      (this as { callCount: number }).callCount = callIndex;
      if (!script) {
        yield {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
        };
        return;
      }
      for (const event of script) {
        if (req.signal?.aborted) return;
        yield event;
      }
      const hasStop = script.some((e) => e.type === "stop" || e.type === "error");
      if (!hasStop) {
        yield {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 10, tokensOut: 5, wallMs: 10, toolCalls: 0, usd: 0.001 },
        };
      }
    },
    async countTokens(_messages: readonly ProviderMessage[]): Promise<Result<number>> {
      return { ok: true, value: 10 };
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: captures cycle-guard recordToolCall calls
// ---------------------------------------------------------------------------

// We verify cycle-guard fingerprint indirectly via the recorder
// (which captures corrected tool_call events). That is sufficient for M3c2.

describe("ADR 0034: agent-runner applies pre-dispatch tool-call correction", () => {
  it("corrects {count: '5'} to {count: 5} before invoking the tool", async () => {
    const received: { input: unknown }[] = [];
    const tool = makeCountedActionTool(received);

    // Script: first call emits a tool call with a bad string count, second call ends.
    const provider = makeScriptedProvider("mock", [TOOL_CALL_SCRIPT, FINISH_SCRIPT]);

    const kernel = new Kernel(
      {
        mode: "auto",
        reproducibility: "free",
        lineage: { maxDepth: 4 },
        bus: { bufferSize: 256 },
        roles: {},
        // No adjudicator — use trustMode: "implicit" to skip verdict gating
        trustMode: "implicit",
      },
      {},
    );
    kernel.mountProvider(provider);
    kernel.getToolRegistry().register(tool);
    kernel.setSession(sessId("sess-correction-1"), "contract-correction" as never);

    const spawn = await kernel.spawn(makeSpec(agentId("correction-agent-1")));
    expect(spawn.ok).toBe(true);
    if (!spawn.ok) return;

    await kernel.runAgent(spawn.value);

    // The tool must have been called exactly once.
    expect(received).toHaveLength(1);

    // The critical assertion: count must be a number (5), not the string "5".
    const toolInput = received[0]?.input as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(typeof toolInput["count"]).toBe("number");
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(toolInput["count"]).toBe(5);
  }, 10_000);

  it("leaves already-correct input unchanged (no-op path)", async () => {
    const received: { input: unknown }[] = [];
    const tool = makeCountedActionTool(received);

    // This time the provider sends count: 5 (already a number)
    const correctScript: ReadonlyArray<ProviderEvent> = [
      {
        type: "tool_call_start",
        toolCallId: "tc-correction-2",
        name: "counted-action",
      },
      {
        type: "tool_call_input_delta",
        toolCallId: "tc-correction-2",
        partial: JSON.stringify({ count: 5 }), // number — no correction needed
      },
      { type: "tool_call_end", toolCallId: "tc-correction-2" },
    ];

    const provider = makeScriptedProvider("mock", [correctScript, FINISH_SCRIPT]);

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
    kernel.mountProvider(provider);
    kernel.getToolRegistry().register(tool);
    kernel.setSession(sessId("sess-correction-2"), "contract-correction" as never);

    const spawn = await kernel.spawn(makeSpec(agentId("correction-agent-2")));
    expect(spawn.ok).toBe(true);
    if (!spawn.ok) return;

    await kernel.runAgent(spawn.value);

    expect(received).toHaveLength(1);
    const toolInput = received[0]?.input as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(typeof toolInput["count"]).toBe("number");
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(toolInput["count"]).toBe(5);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// M3c2 finding #4: assistant message AND cycle-guard fingerprint use corrected input
// ---------------------------------------------------------------------------

describe("M3c2 finding #4: corrected input propagates to assistant message and recorder", () => {
  it("assistant message echoed to the model uses corrected {count: 5}, not raw {count: '5'}", async () => {
    const received: { input: unknown }[] = [];
    const tool = makeCountedActionTool(received);

    // Use a capturing provider so we can inspect what messages are sent on the
    // second call (which must contain the assistant message with corrected input).
    const provider = makeCapturingProvider("mock", [TOOL_CALL_SCRIPT, FINISH_SCRIPT]);

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
    kernel.mountProvider(provider);
    kernel.getToolRegistry().register(tool);
    kernel.setSession(sessId("sess-correction-msg-1"), "contract-correction-msg" as never);

    const spawn = await kernel.spawn(makeSpec(agentId("correction-msg-agent-1")));
    expect(spawn.ok).toBe(true);
    if (!spawn.ok) return;

    await kernel.runAgent(spawn.value);

    // The provider must have been called twice (tool call + finish).
    expect(provider.capturedRequests.length).toBe(2);

    // The second request's messages should contain an assistant message with
    // the corrected tool input ({count: 5}, not {count: "5"}).
    const secondReq = provider.capturedRequests[1];
    expect(secondReq).toBeDefined();

    // Find the assistant message that contains the tool_use content.
    const assistantMessages = secondReq?.messages.filter((m) => m.role === "assistant") ?? [];
    expect(assistantMessages.length).toBeGreaterThan(0);

    const assistantMsg = assistantMessages[assistantMessages.length - 1];
    expect(assistantMsg).toBeDefined();

    // Find the tool_use content item within the assistant message.
    const toolUseItems = (assistantMsg?.content ?? []).filter(
      (c) => typeof c === "object" && c !== null && "type" in c && c.type === "tool_use",
    );
    expect(toolUseItems.length).toBeGreaterThan(0);

    const toolUseItem = toolUseItems[0] as { type: "tool_use"; input: unknown };
    const assistantInput = toolUseItem?.input as Record<string, unknown>;

    // The critical assertion: assistant message must show corrected count: 5
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(typeof assistantInput["count"]).toBe("number");
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(assistantInput["count"]).toBe(5);
  }, 10_000);

  it("recorder captures corrected input (count: 5) in tool_call events", async () => {
    const received: { input: unknown }[] = [];
    const tool = makeCountedActionTool(received);
    const provider = makeScriptedProvider("mock", [TOOL_CALL_SCRIPT, FINISH_SCRIPT]);

    // Minimal inline recorder to capture tool_call events without importing @lwrf42/emerge-replay.
    const recordedEvents: import("../contracts/index.js").RecordedEvent[] = [];
    const inlineRecorder: import("../contracts/index.js").SessionRecorder = {
      start(_sid, _contract) {
        /* no-op */
      },
      record(event) {
        recordedEvents.push(event);
      },
      async end(_sid) {
        return {
          ok: true,
          value: {
            sessionId: _sid,
            startedAt: 0,
            endedAt: Date.now(),
            contractRef: "contract-correction-rec" as never,
            events: [...recordedEvents],
            schemaVersion: "1",
          },
        };
      },
    };

    const kernel = new Kernel(
      {
        mode: "auto",
        reproducibility: "free",
        lineage: { maxDepth: 4 },
        bus: { bufferSize: 256 },
        roles: {},
        trustMode: "implicit",
      },
      { recorder: inlineRecorder },
    );
    kernel.mountProvider(provider);
    kernel.getToolRegistry().register(tool);
    kernel.setSession(sessId("sess-correction-rec-1"), "contract-correction-rec" as never);

    const spawn = await kernel.spawn(makeSpec(agentId("correction-rec-agent-1")));
    expect(spawn.ok).toBe(true);
    if (!spawn.ok) return;

    await kernel.runAgent(spawn.value);
    await kernel.endSession();

    // Check the recorded tool_call events have the corrected input.
    const toolCallEvents = recordedEvents.filter((e) => e.kind === "tool_call");
    expect(toolCallEvents.length).toBeGreaterThan(0);

    const toolEvent = toolCallEvents[0];
    if (toolEvent?.kind === "tool_call") {
      const recordedInput = toolEvent.call.input as Record<string, unknown>;
      // The critical assertion: recorder must capture the corrected count: 5, not "5".
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
      expect(typeof recordedInput["count"]).toBe("number");
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
      expect(recordedInput["count"]).toBe(5);
    }
  }, 10_000);
});
