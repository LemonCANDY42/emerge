/**
 * AnthropicProvider — adapter for the Anthropic SDK.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  ProviderToolSpec,
  Result,
} from "@emerge/kernel/contracts";

export interface AnthropicProviderConfig {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseURL?: string;
}

const DEFAULT_MODEL = "claude-opus-4-7";

export class AnthropicProvider implements Provider {
  readonly capabilities: ProviderCapabilities;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: AnthropicProviderConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.client = new Anthropic({
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
      apiKey: config.apiKey ?? process.env["ANTHROPIC_API_KEY"],
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
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
        thinking: false,
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

    const anthropicTools: Anthropic.Tool[] | undefined =
      req.tools && req.tools.length > 0
        ? req.tools.map((t: ProviderToolSpec) => ({
            name: t.name,
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
      if (req.temperature !== undefined) streamParams.temperature = req.temperature;
      if (req.stopSequences) streamParams.stop_sequences = [...req.stopSequences];

      const stream = await this.client.messages.create(streamParams);

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
            const toolName = event.content_block.name;
            toolCallIdToName.set(toolCallId, toolName);
            indexToToolCallId.set(event.index, toolCallId);
            yield { type: "tool_call_start", toolCallId, name: toolName };
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const toolCallId = indexToToolCallId.get(event.index) ?? `idx-${event.index}`;
            yield { type: "tool_call_input_delta", toolCallId, partial: event.delta.partial_json };
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
          wallMs: 0,
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
