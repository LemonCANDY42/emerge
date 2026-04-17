/**
 * AgentRunner — implements AgentHandle and the perceive→decide→act→observe loop.
 */

import type {
  AgentCard,
  AgentHandle,
  AgentId,
  AgentSnapshot,
  AgentSpec,
  AgentState,
  Bus,
  BusEnvelope,
  ContractError,
  CorrelationId,
  Memory,
  MemoryItem,
  Provider,
  ProviderContent,
  ProviderEvent,
  ProviderMessage,
  Result,
  Sandbox,
  SandboxRequest,
  SchemaRef,
  SessionId,
  SignalKind,
  Telemetry,
  ToolInvocation,
  ToolRegistry,
  ToolResult,
} from "../contracts/index.js";
import type { SessionRecorder } from "../contracts/replay.js";
import type { Scheduler } from "./scheduler.js";

export interface AgentRunnerDeps {
  spec: AgentSpec;
  provider: Provider;
  toolRegistry: ToolRegistry;
  sandbox: Sandbox;
  memory: Memory;
  bus: Bus;
  scheduler: Scheduler;
  sessionId: SessionId;
  correlationId: CorrelationId;
  telemetry?: Telemetry | undefined;
  recorder?: SessionRecorder | undefined;
}

function makeCard(spec: AgentSpec, provider: Provider): AgentCard {
  return {
    id: spec.id,
    role: spec.role,
    description: spec.description ?? spec.role,
    capabilities: spec.capabilities,
    io: {
      accepts: {
        "~standard": { version: 1, vendor: "emerge", validate: (v) => ({ value: v }) },
      } as SchemaRef,
      produces: {
        "~standard": { version: 1, vendor: "emerge", validate: (v) => ({ value: v }) },
      } as SchemaRef,
    },
    budget: spec.budget,
    termination: spec.termination,
    acl: spec.acl,
    lineage: spec.lineage,
  };
}

export class AgentRunner implements AgentHandle {
  readonly id: AgentId;
  private readonly deps: AgentRunnerDeps;
  private readonly agentCard: AgentCard;
  private _state: AgentState = "idle";
  private readonly snapshotListeners: Array<(s: AgentSnapshot) => void> = [];
  private _lastActivityAt = Date.now();

  constructor(deps: AgentRunnerDeps) {
    this.deps = deps;
    this.id = deps.spec.id;
    this.agentCard = makeCard(deps.spec, deps.provider);
  }

  card(): AgentCard {
    return this.agentCard;
  }

  async send(envelope: BusEnvelope): Promise<Result<void, ContractError>> {
    return this.deps.bus.send(envelope);
  }

  async snapshot(): Promise<AgentSnapshot> {
    const sched = this.deps.scheduler.get(this.id);
    return {
      id: this.id,
      state: this._state,
      usage: sched?.usage ?? { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
      lastActivityAt: this._lastActivityAt,
    };
  }

  async *events(): AsyncIterable<AgentSnapshot> {
    // Simplified: yield current snapshot; real impl would push on state changes.
    yield await this.snapshot();
  }

  /**
   * Run the perceive → decide → act → observe loop until termination.
   */
  async run(): Promise<void> {
    const { spec, scheduler, sessionId, correlationId, bus } = this.deps;
    const schedState = scheduler.register(spec.id, spec.termination);

    this.setState("thinking");

    // Working memory: start with system prompt
    const messages: ProviderMessage[] = [];
    if (spec.system.kind === "literal") {
      messages.push({ role: "system", content: spec.system.text });
    }

    // Fetch initial memory
    const memResult = await this.deps.memory.recall(
      {},
      { session: sessionId, agents: [this.id] },
      { maxItems: 20 },
    );
    if (memResult.ok) {
      for (const item of memResult.value.items) {
        messages.push({ role: "user", content: [{ type: "text", text: item.content }] });
      }
    }

    // Resolve available tools
    const tools = this.deps.toolRegistry.resolve(spec.toolsAllowed);

    while (true) {
      const stepResult = scheduler.preStep(schedState, sessionId, correlationId);
      if (!stepResult.continue) {
        this.setState("completed");
        await bus.send({
          kind: "result",
          correlationId,
          sessionId,
          from: this.id,
          to: { kind: "broadcast" },
          timestamp: Date.now(),
          payload: { reason: stepResult.reason, state: "completed" },
        });
        break;
      }

      if (schedState.abortController.signal.aborted) {
        this.setState("failed");
        break;
      }

      this.setState("thinking");

      // Build provider tool specs
      const providerTools = tools.map((t) => ({
        name: t.spec.name,
        description: t.spec.description,
        inputSchema: t.spec.jsonSchema ?? { type: "object" as const },
      }));

      const req: import("../contracts/index.js").ProviderRequest = {
        messages: [...messages],
        ...(providerTools.length > 0 ? { tools: providerTools } : {}),
        signal: schedState.abortController.signal,
      };

      if (this.deps.recorder) {
        // record the start of a provider call (events recorded after)
      }

      const callStart = Date.now();
      let textAccumulator = "";
      const pendingToolCalls = new Map<string, { name: string; inputJson: string }>();
      const completedToolCalls: Array<{
        toolCallId: string;
        name: string;
        input: unknown;
        result: ToolResult;
      }> = [];
      let stopUsage = { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 };
      let stopReason = "end_turn";
      const recordedEvents: ProviderEvent[] = [];

      for await (const event of this.deps.provider.invoke(req)) {
        recordedEvents.push(event);

        if (schedState.abortController.signal.aborted) break;

        if (event.type === "text_delta") {
          textAccumulator += event.text;
          // emit delta to subscribers
          await bus.send({
            kind: "delta",
            correlationId,
            sessionId,
            from: this.id,
            to: { kind: "broadcast" },
            timestamp: Date.now(),
            chunk: event.text,
            seq: schedState.iteration,
          });
        } else if (event.type === "tool_call_start") {
          pendingToolCalls.set(event.toolCallId, { name: event.name, inputJson: "" });
        } else if (event.type === "tool_call_input_delta") {
          const tc = pendingToolCalls.get(event.toolCallId);
          if (tc) tc.inputJson += event.partial;
        } else if (event.type === "tool_call_end") {
          // nothing to do here; we process on stop
        } else if (event.type === "stop") {
          stopUsage = event.usage;
          stopReason = event.reason;
        } else if (event.type === "error") {
          this.setState("failed");
          return;
        }
      }

      if (this.deps.recorder) {
        this.deps.recorder.record({
          kind: "provider_call",
          at: callStart,
          req,
          events: recordedEvents,
        });
      }

      scheduler.recordUsage(schedState, stopUsage);
      this._lastActivityAt = Date.now();

      // Append assistant message
      const assistantContent: ProviderContent[] = [];
      if (textAccumulator) {
        assistantContent.push({ type: "text", text: textAccumulator });
      }
      for (const [toolCallId, tc] of pendingToolCalls) {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(tc.inputJson || "{}");
        } catch {
          parsed = {};
        }
        assistantContent.push({ type: "tool_use", toolCallId, name: tc.name, input: parsed });
      }

      if (assistantContent.length > 0) {
        messages.push({ role: "assistant", content: assistantContent });
      }

      // Append to memory
      if (textAccumulator) {
        await this.deps.memory.append([
          {
            tier: "working",
            content: textAccumulator,
            attributes: { role: "assistant", agent: this.id },
          },
        ]);
      }

      // Check termination predicate
      if (spec.termination.done.kind === "tool_emitted") {
        const targetTool = spec.termination.done.tool;
        if (pendingToolCalls.size > 0) {
          for (const tc of pendingToolCalls.values()) {
            if (tc.name === targetTool) {
              this.setState("completed");
              await bus.send({
                kind: "result",
                correlationId,
                sessionId,
                from: this.id,
                to: { kind: "broadcast" },
                timestamp: Date.now(),
                payload: { reason: "tool_emitted", tool: targetTool },
              });
              return;
            }
          }
        }
      }

      // If no tool calls and stop reason is end_turn, we're done
      if (pendingToolCalls.size === 0 && stopReason === "end_turn") {
        this.setState("completed");
        await bus.send({
          kind: "result",
          correlationId,
          sessionId,
          from: this.id,
          to: { kind: "broadcast" },
          timestamp: Date.now(),
          payload: { text: textAccumulator, reason: "end_turn" },
        });
        return;
      }

      // Execute tool calls
      if (pendingToolCalls.size > 0) {
        this.setState("calling_tool");
        const toolResultContents: ProviderContent[] = [];

        for (const [toolCallId, tc] of pendingToolCalls) {
          let parsed: unknown = {};
          try {
            parsed = JSON.parse(tc.inputJson || "{}");
          } catch {
            parsed = {};
          }

          const tool = this.deps.toolRegistry.get(tc.name);
          if (!tool) {
            toolResultContents.push({
              type: "tool_result",
              toolCallId,
              output: { error: `Tool ${tc.name} not found` },
              isError: true,
            });
            continue;
          }

          // Sandbox authorization
          const effects = tool.spec.permission.effects;
          let authorized = true;
          for (const effect of effects) {
            const sandboxReq: SandboxRequest = { effect, target: tc.name };
            const authResult = await this.deps.sandbox.authorize(sandboxReq);
            if (!authResult.ok || authResult.value.kind === "deny") {
              authorized = false;
              break;
            }
          }

          if (!authorized) {
            toolResultContents.push({
              type: "tool_result",
              toolCallId,
              output: { error: `Permission denied for tool ${tc.name}` },
              isError: true,
            });
            continue;
          }

          const invocation: ToolInvocation = {
            toolCallId: toolCallId as never,
            callerAgent: this.id,
            name: tc.name,
            input: parsed,
            signal: schedState.abortController.signal,
          };

          const toolStart = Date.now();
          const toolResult = await this.deps.sandbox.run(
            { effect: effects[0] ?? "state_read", target: tc.name },
            async () => tool.invoke(invocation),
          );

          const toolEnd = Date.now();

          let result: ToolResult;
          if (toolResult.ok && toolResult.value.ok) {
            result = toolResult.value.value;
          } else {
            result = {
              ok: false,
              preview: toolResult.ok
                ? String((toolResult.value as { error?: unknown }).error)
                : toolResult.error.message,
            };
          }

          if (this.deps.recorder) {
            this.deps.recorder.record({
              kind: "tool_call",
              at: toolStart,
              call: invocation,
              result,
            });
          }

          completedToolCalls.push({ toolCallId, name: tc.name, input: parsed, result });

          // Apply projections if declared
          let preview = result.preview;
          if (spec.projections) {
            for (const proj of spec.projections) {
              if (proj.tool === tc.name || proj.tool === "*") {
                for (const step of proj.steps) {
                  if (step.kind === "cap") {
                    if (preview.length > step.maxBytes) {
                      preview =
                        preview.slice(0, step.maxBytes) +
                        (step.truncationMessage ?? "...[truncated]");
                    }
                  }
                  // other projection kinds stubbed for M1
                }
              }
            }
          }

          toolResultContents.push({
            type: "tool_result",
            toolCallId,
            output: preview,
          });

          schedState.cycleGuard.recordToolCall(
            this.id,
            tc.name,
            JSON.stringify(parsed),
            result.preview.slice(0, 64),
          );

          scheduler.recordUsage(schedState, {
            tokensIn: 0,
            tokensOut: 0,
            wallMs: toolEnd - toolStart,
            toolCalls: 1,
            usd: 0,
          });
        }

        // Append tool results as user message
        messages.push({ role: "user", content: toolResultContents });

        // Append to memory
        for (const tr of completedToolCalls) {
          await this.deps.memory.append([
            {
              tier: "episodic",
              content: `tool:${tr.name} → ${tr.result.preview.slice(0, 200)}`,
              attributes: { tool: tr.name, agent: this.id },
            },
          ]);
        }

        // Check tool-emitted termination predicate
        if (spec.termination.done.kind === "tool_emitted") {
          const targetTool = spec.termination.done.tool;
          for (const tr of completedToolCalls) {
            if (tr.name === targetTool) {
              this.setState("completed");
              await bus.send({
                kind: "result",
                correlationId,
                sessionId,
                from: this.id,
                to: { kind: "broadcast" },
                timestamp: Date.now(),
                payload: { reason: "tool_emitted", tool: targetTool },
              });
              return;
            }
          }
        }
      }
    }
  }

  private setState(s: AgentState): void {
    this._state = s;
    this.deps.scheduler.setState(this.id, s);
    this._lastActivityAt = Date.now();
  }
}
