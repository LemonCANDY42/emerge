/**
 * AnthropicProvider — adapter for the Anthropic SDK.
 * M3b: exports the recommended schema adapter for Anthropic tool-use.
 *
 * Extended thinking:
 *   Set `thinking: { type: "enabled", budget_tokens: N }` in config to enable
 *   Claude's extended thinking. Thinking delta events are emitted as
 *   ProviderEvent { type: "thinking_delta", text }.
 *
 *   Environment variable: ANTHROPIC_THINKING_BUDGET=8192 (positive integer).
 *   Absent or 0 disables thinking.
 */

// M3b: export the Anthropic-tuned schema adapter so consumers can mount it in one line:
//   kernel.mountSchemaAdapter(provider.capabilities.id, anthropicSchemaAdapter)
export { anthropicAdapter as anthropicSchemaAdapter } from "@emerge/kernel/runtime";

import Anthropic from "@anthropic-ai/sdk";
import type {
  Divergence,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  ProviderToolSpec,
  ReproducibilityTier,
  Result,
} from "@emerge/kernel/contracts";
import type { RetryOptions, SleepFn } from "./retry.js";
import { DEFAULT_RETRY_OPTIONS, defaultSleep, withRetry } from "./retry.js";
import { buildToolNameMap } from "./sanitize.js";

/**
 * Extended thinking configuration for Claude models that support it
 * (claude-3.7-sonnet, claude-opus-4-x).
 *
 * When `type: "enabled"`, the `budget_tokens` controls how many tokens
 * Claude may use for internal reasoning before producing its response.
 *
 * Environment variable: ANTHROPIC_THINKING_BUDGET=8192
 *   A positive integer enables thinking with that budget.
 *   Absent or 0 disables thinking.
 */
export type AnthropicThinkingConfig =
  | { readonly type: "enabled"; readonly budget_tokens: number }
  | { readonly type: "disabled" };

export interface AnthropicProviderConfig {
  readonly apiKey?: string;
  readonly model?: string;
  /**
   * Override the API base URL. Useful for:
   *   - OpenRouter: baseURL = "https://openrouter.ai/api/v1"
   *   - Auth proxies / corporate gateways
   *   - Local Anthropic-compatible services
   */
  readonly baseURL?: string;
  /**
   * Extra HTTP headers forwarded on every request. Useful for:
   *   - OpenRouter: { "HTTP-Referer": "...", "X-Title": "..." }
   *   - Auth proxies: { "X-Auth-Token": "..." }
   */
  readonly extraHeaders?: Record<string, string>;
  /** Reproducibility tier. "pinned" pins temperature/top-p and passes seed when available. */
  readonly tier?: ReproducibilityTier;
  /** Fixed seed for pinned tier (best-effort — Anthropic API may not honour it). */
  readonly pinSeed?: number;
  /** Fixed temperature for pinned tier. Default 0 (most deterministic). */
  readonly pinTemperature?: number;
  /** Fixed top-p for pinned tier. */
  readonly pinTopP?: number;
  /** Sink for divergence records when pinned tier detects mismatches. */
  readonly divergenceSink?: (d: Divergence) => void;
  /**
   * Retry-on-5xx configuration. Set to `false` to disable all retries.
   * Default: 3 attempts, 500ms initial delay, 10s cap, with jitter.
   */
  readonly retry?: RetryOptions | false;
  /**
   * Extended thinking configuration. When `type: "enabled"`, Claude will
   * perform internal reasoning before responding, and thinking_delta events
   * will be emitted. Models that support this: claude-3.7-sonnet, claude-opus-4-x.
   *
   * Read from ANTHROPIC_THINKING_BUDGET env var if not provided explicitly.
   */
  readonly thinking?: AnthropicThinkingConfig;
}

const DEFAULT_MODEL = "claude-opus-4-7";

export class AnthropicProvider implements Provider {
  readonly capabilities: ProviderCapabilities;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly tier: ReproducibilityTier;
  private readonly pinSeed: number | undefined;
  private readonly pinTemperature: number;
  private readonly pinTopP: number | undefined;
  private readonly divergenceSink: ((d: Divergence) => void) | undefined;
  private readonly retryOpts: RetryOptions | false;
  private readonly thinkingConfig: AnthropicThinkingConfig | undefined;
  // Injected sleep for testability
  readonly _sleep: SleepFn;

  constructor(config: AnthropicProviderConfig = {}, _sleep: SleepFn = defaultSleep) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.tier = config.tier ?? "free";
    this.pinSeed = config.pinSeed;
    this.pinTemperature = config.pinTemperature ?? 0;
    this.pinTopP = config.pinTopP;
    this.divergenceSink = config.divergenceSink;
    this.retryOpts = config.retry !== undefined ? config.retry : DEFAULT_RETRY_OPTIONS;
    this._sleep = _sleep;

    // Resolve thinking config: explicit config wins over env var
    if (config.thinking !== undefined) {
      this.thinkingConfig = config.thinking;
    } else {
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
      const budgetEnv = process.env["ANTHROPIC_THINKING_BUDGET"];
      if (budgetEnv !== undefined) {
        const budget = Number.parseInt(budgetEnv, 10);
        if (!Number.isNaN(budget) && budget > 0) {
          this.thinkingConfig = { type: "enabled", budget_tokens: budget };
        } else {
          this.thinkingConfig = { type: "disabled" };
        }
      } else {
        this.thinkingConfig = undefined;
      }
    }

    this.client = new Anthropic({
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
      apiKey: config.apiKey ?? process.env["ANTHROPIC_API_KEY"],
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.extraHeaders !== undefined ? { defaultHeaders: config.extraHeaders } : {}),
    });
    this.capabilities = {
      id: `anthropic-${this.model}`,
      claimed: {
        contextWindow: 1_000_000,
        maxOutputTokens: 8192,
        nativeToolUse: true,
        streamingToolUse: true,
        vision: true,
        audio: false,
        thinking: !!(this.thinkingConfig !== undefined && this.thinkingConfig.type === "enabled"),
        latencyTier: "interactive",
        costPerMtokIn: 15,
        costPerMtokOut: 75,
      },
    };
  }

  async *invoke(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    // Separate system from messages
    let systemText: string | undefined;
    const chatMessages: Anthropic.MessageParam[] = [];

    for (const msg of req.messages) {
      if (msg.role === "system") {
        systemText = msg.content;
        continue;
      }

      if (msg.role === "tool") {
        // tool results go as user message with tool_result content blocks
        const blocks: Anthropic.ToolResultBlockParam[] = [];
        for (const c of msg.content) {
          if (c.type === "tool_result") {
            if (c.isError === true) {
              blocks.push({
                type: "tool_result",
                tool_use_id: c.toolCallId,
                content: typeof c.output === "string" ? c.output : JSON.stringify(c.output),
                is_error: true,
              });
            } else {
              blocks.push({
                type: "tool_result",
                tool_use_id: c.toolCallId,
                content: typeof c.output === "string" ? c.output : JSON.stringify(c.output),
              });
            }
          }
        }
        chatMessages.push({ role: "user", content: blocks });
        continue;
      }

      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const c of msg.content) {
        if (c.type === "text") {
          blocks.push({ type: "text", text: c.text });
        } else if (c.type === "tool_use") {
          blocks.push({
            type: "tool_use",
            id: c.toolCallId,
            name: c.name,
            input: c.input as Record<string, unknown>,
          });
        } else if (c.type === "thinking") {
          blocks.push({ type: "text", text: `<thinking>${c.text}</thinking>` });
        }
      }

      chatMessages.push({ role: msg.role as "user" | "assistant", content: blocks });
    }

    // Build per-request name map: sanitizes dotted emerge names (e.g. "fs.read" → "fs_read")
    // and enables reverse-translation of incoming tool_use names back to original.
    const nameMap = buildToolNameMap(req.tools ?? []);

    const anthropicTools: Anthropic.Tool[] | undefined =
      req.tools && req.tools.length > 0
        ? req.tools.map((t: ProviderToolSpec) => ({
            name: nameMap.originalToWire.get(t.name) ?? t.name,
            description: t.description,
            input_schema: (t.inputSchema ?? { type: "object" }) as Anthropic.Tool.InputSchema,
          }))
        : undefined;

    // Track tool call IDs and their names from start events
    const toolCallIdToName = new Map<string, string>();
    // Track input_json_delta by content block index
    const indexToToolCallId = new Map<number, string>();

    try {
      const streamParams: Anthropic.MessageCreateParamsStreaming = {
        model: this.model,
        max_tokens: req.maxOutputTokens ?? 4096,
        messages: chatMessages,
        stream: true,
      };
      if (systemText) streamParams.system = systemText;
      if (anthropicTools) streamParams.tools = anthropicTools;
      if (req.stopSequences) streamParams.stop_sequences = [...req.stopSequences];

      // Extended thinking: inject the thinking parameter when enabled.
      // The Anthropic SDK types don't include `thinking` in the public params
      // type yet for all SDK versions, so we cast through unknown.
      if (this.thinkingConfig !== undefined && this.thinkingConfig.type === "enabled") {
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
        (streamParams as unknown as Record<string, unknown>)["thinking"] = {
          type: "enabled",
          budget_tokens: this.thinkingConfig.budget_tokens,
        };
      }

      // Pinned tier: override temperature/top-p for best-effort reproducibility
      if (this.tier === "pinned") {
        streamParams.temperature = this.pinTemperature;
        if (this.pinTopP !== undefined) streamParams.top_p = this.pinTopP;
        // Anthropic API does not expose a 'seed' parameter in the public SDK;
        // record a non-fatal Divergence noting that seed pinning isn't available.
        if (this.pinSeed !== undefined) {
          this.divergenceSink?.({
            at: Date.now(),
            providerId: this.capabilities.id,
            tier: "pinned",
            category: "stop_reason",
            expectedHash: String(this.pinSeed),
            actualHash: "n/a",
            note: "Anthropic SDK does not expose seed pinning; temperature pinned to 0 instead",
          });
        }
      } else if (req.temperature !== undefined) {
        streamParams.temperature = req.temperature;
      }

      // M9: capture wall time around the actual API call
      const startMs = Date.now();

      // Retry wraps the stream-creation call only. Once the stream is open and
      // we've started yielding events, mid-stream errors are NOT retried to
      // avoid duplicating already-emitted events.
      const stream = await withRetry(
        () => this.client.messages.create(streamParams),
        this.retryOpts,
        "anthropic",
        this._sleep,
      );

      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: Anthropic.Message["stop_reason"] = "end_turn";

      for await (const event of stream) {
        if (req.signal?.aborted) return;

        if (event.type === "message_start") {
          inputTokens = event.message.usage.input_tokens;
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            const toolCallId = event.content_block.id;
            // Reverse-translate wire name (e.g. "fs_read") back to original emerge
            // name (e.g. "fs.read") before emitting to the agent-runner.
            const wireName = event.content_block.name;
            const toolName = nameMap.wireToOriginal.get(wireName) ?? wireName;
            toolCallIdToName.set(toolCallId, toolName);
            indexToToolCallId.set(event.index, toolCallId);
            yield { type: "tool_call_start", toolCallId, name: toolName };
          }
          // thinking_start: content_block.type === "thinking" — no event to yield
          // on block start; thinking text arrives via thinking_delta below.
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const toolCallId = indexToToolCallId.get(event.index) ?? `idx-${event.index}`;
            yield { type: "tool_call_input_delta", toolCallId, partial: event.delta.partial_json };
          } else if (event.delta.type === "thinking_delta") {
            // Extended thinking: emit thinking_delta events so callers can
            // surface or record the model's reasoning trace.
            yield { type: "thinking_delta", text: event.delta.thinking };
          }
        } else if (event.type === "content_block_stop") {
          const toolCallId = indexToToolCallId.get(event.index);
          if (toolCallId) {
            yield { type: "tool_call_end", toolCallId };
          }
        } else if (event.type === "message_delta") {
          if (event.usage) outputTokens = event.usage.output_tokens;
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
        }
      }

      const resolvedStopReason =
        stopReason === "tool_use"
          ? "tool_use"
          : stopReason === "max_tokens"
            ? "max_tokens"
            : stopReason === "stop_sequence"
              ? "stop_sequence"
              : "end_turn";

      const usd =
        (inputTokens * (this.capabilities.claimed.costPerMtokIn ?? 0) +
          outputTokens * (this.capabilities.claimed.costPerMtokOut ?? 0)) /
        1_000_000;

      yield {
        type: "stop",
        reason: resolvedStopReason,
        usage: {
          tokensIn: inputTokens,
          tokensOut: outputTokens,
          wallMs: Date.now() - startMs,
          toolCalls: toolCallIdToName.size,
          usd,
        },
      };
    } catch (err: unknown) {
      if (req.signal?.aborted) return;
      yield {
        type: "error",
        error: {
          code: "E_PROVIDER",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  async countTokens(messages: readonly ProviderMessage[]): Promise<Result<number>> {
    try {
      const chatMessages: Anthropic.MessageParam[] = [];
      let systemText: string | undefined;

      for (const msg of messages) {
        if (msg.role === "system") {
          systemText = msg.content;
          continue;
        }
        if (msg.role === "tool") {
          const blocks: Anthropic.ToolResultBlockParam[] = msg.content
            .filter((c) => c.type === "tool_result")
            .map((c) => ({
              type: "tool_result" as const,
              tool_use_id: c.type === "tool_result" ? c.toolCallId : "",
              content: c.type === "tool_result" ? String(c.output) : "",
            }));
          chatMessages.push({ role: "user", content: blocks });
        } else {
          chatMessages.push({
            role: msg.role as "user" | "assistant",
            content: msg.content
              .filter((c) => c.type === "text")
              .map((c) => ({ type: "text" as const, text: c.type === "text" ? c.text : "" })),
          });
        }
      }

      const countParams: Anthropic.Messages.MessageCountTokensParams = {
        model: this.model,
        messages: chatMessages,
      };
      if (systemText) countParams.system = systemText;

      const result = await this.client.messages.countTokens(countParams);
      return { ok: true, value: result.input_tokens };
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "E_COUNT_TOKENS",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
