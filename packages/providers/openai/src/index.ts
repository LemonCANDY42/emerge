/**
 * OpenAIProvider — adapter for the OpenAI SDK.
 *
 * Supports two protocols:
 *   - "chat"      (default): client.chat.completions.create({ stream: true })
 *   - "responses": client.responses.create({ stream: true }) — newer Responses API
 *
 * When `baseURL` is provided, the client routes to that endpoint instead of
 * api.openai.com, which enables custom OpenAI-compatible services.
 *
 * M3c1: exports the recommended schema adapter for OpenAI tool-use.
 */

// Re-export the OpenAI-tuned schema adapter so consumers can mount it in one line:
//   kernel.mountSchemaAdapter(provider.capabilities.id, openaiSchemaAdapter)
export { openaiAdapter as openaiSchemaAdapter } from "@emerge/kernel/runtime";

import type {
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  ProviderStopReason,
  ProviderToolSpec,
  Result,
} from "@emerge/kernel/contracts";
import OpenAI from "openai";

export type OpenAIProtocol = "chat" | "responses";

export interface OpenAIProviderConfig {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseURL?: string;
  /**
   * "chat"      — uses chat.completions.create (default, widely supported)
   * "responses" — uses responses.create (newer Responses API, OpenAI-native only)
   */
  readonly protocol?: OpenAIProtocol;
  /**
   * Extra HTTP headers forwarded on every request — useful for OpenRouter-style
   * routing headers or auth proxies.
   */
  readonly extraHeaders?: Record<string, string>;
}

// Default GPT-5-class capabilities when model/baseURL not further specified
const DEFAULT_CLAIMED_CAPABILITIES = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  nativeToolUse: true,
  streamingToolUse: true,
  vision: true,
  audio: false,
  thinking: false,
  latencyTier: "interactive" as const,
  costPerMtokIn: 5,
  costPerMtokOut: 15,
};

// Conservative envelope for custom baseURL — we cannot know the model's limits
const CUSTOM_URL_CLAIMED_CAPABILITIES = {
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  nativeToolUse: true,
  streamingToolUse: true,
  vision: false,
  audio: false,
  thinking: false,
  latencyTier: "interactive" as const,
};

const DEFAULT_MODEL = "gpt-4o";

/**
 * Translate a ProviderMessage[] into OpenAI's ChatCompletionMessageParam[].
 */
function toOpenAIMessages(
  messages: readonly ProviderMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      result.push({ role: "system", content: msg.content });
      continue;
    }

    if (msg.role === "tool") {
      // OpenAI tool results come as separate tool messages per call
      for (const c of msg.content) {
        if (c.type === "tool_result") {
          result.push({
            role: "tool",
            tool_call_id: c.toolCallId,
            content: typeof c.output === "string" ? c.output : JSON.stringify(c.output),
          });
        }
      }
      continue;
    }

    if (msg.role === "user") {
      const textParts = msg.content
        .filter((c) => c.type === "text")
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      result.push({ role: "user", content: textParts || " " });
      continue;
    }

    if (msg.role === "assistant") {
      const textContent = msg.content
        .filter((c) => c.type === "text")
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");

      const toolCalls = msg.content
        .filter((c) => c.type === "tool_use")
        .map((c) =>
          c.type === "tool_use"
            ? ({
                id: c.toolCallId,
                type: "function" as const,
                function: {
                  name: c.name,
                  arguments: typeof c.input === "string" ? c.input : JSON.stringify(c.input),
                },
              } satisfies OpenAI.Chat.ChatCompletionMessageToolCall)
            : null,
        )
        .filter((tc): tc is OpenAI.Chat.ChatCompletionMessageToolCall => tc !== null);

      result.push({
        role: "assistant",
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return result;
}

/**
 * Translate ProviderToolSpec[] into OpenAI's ChatCompletionTool[].
 */
function toOpenAITools(tools: readonly ProviderToolSpec[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
    },
  }));
}

/**
 * Map an OpenAI finish_reason to ProviderStopReason.
 */
function mapFinishReason(reason: string | null | undefined): ProviderStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

export class OpenAIProvider implements Provider {
  readonly capabilities: ProviderCapabilities;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly protocol: OpenAIProtocol;

  constructor(config: OpenAIProviderConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.protocol = config.protocol ?? "chat";

    this.client = new OpenAI({
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
      apiKey: config.apiKey ?? process.env["OPENAI_API_KEY"] ?? "no-key",
      ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
      ...(config.extraHeaders !== undefined ? { defaultHeaders: config.extraHeaders } : {}),
    });

    // Use conservative claims when a custom baseURL is specified
    const claimed =
      config.baseURL !== undefined ? CUSTOM_URL_CLAIMED_CAPABILITIES : DEFAULT_CLAIMED_CAPABILITIES;

    this.capabilities = {
      id: `openai-${this.model}`,
      claimed,
    };
  }

  async *invoke(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    if (this.protocol === "responses") {
      yield* this.invokeResponses(req);
    } else {
      yield* this.invokeChat(req);
    }
  }

  private async *invokeChat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const messages = toOpenAIMessages(req.messages);
    const tools = req.tools && req.tools.length > 0 ? toOpenAITools(req.tools) : undefined;

    const startMs = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;

    // Track tool calls by index
    const indexToCallId = new Map<number, string>();
    const callIdToName = new Map<string, string>();

    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: req.maxOutputTokens ?? 4096,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.stopSequences !== undefined ? { stop: [...req.stopSequences] } : {}),
        ...(tools !== undefined ? { tools, tool_choice: "auto" } : {}),
      });

      let finishReason: string | null = null;

      for await (const chunk of stream) {
        if (req.signal?.aborted) return;

        // Usage may appear in final chunk
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;

        // Text content
        if (delta.content) {
          yield { type: "text_delta", text: delta.content };
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (tc.id !== undefined) {
              // First delta for this tool call
              const toolCallId = tc.id;
              const toolName = tc.function?.name ?? "";
              indexToCallId.set(idx, toolCallId);
              callIdToName.set(toolCallId, toolName);
              yield { type: "tool_call_start", toolCallId, name: toolName };
            }
            const toolCallId = indexToCallId.get(idx);
            if (toolCallId && tc.function?.arguments !== undefined) {
              yield {
                type: "tool_call_input_delta",
                toolCallId,
                partial: tc.function.arguments,
              };
            }
          }
        }
      }

      // Emit tool_call_end for each tool call we started
      for (const [, toolCallId] of indexToCallId) {
        yield { type: "tool_call_end", toolCallId };
      }

      const usd =
        (inputTokens * (this.capabilities.claimed.costPerMtokIn ?? 0) +
          outputTokens * (this.capabilities.claimed.costPerMtokOut ?? 0)) /
        1_000_000;

      yield {
        type: "stop",
        reason: mapFinishReason(finishReason),
        usage: {
          tokensIn: inputTokens,
          tokensOut: outputTokens,
          wallMs: Date.now() - startMs,
          toolCalls: callIdToName.size,
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

  private async *invokeResponses(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    // The Responses API uses a different shape. We use `responses.create` with stream.
    // Translate ProviderMessage[] → Responses API input format.
    // Tool calls from the Responses API arrive as output_text.delta and function_call items.

    const startMs = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    const callIdToName = new Map<string, string>();

    // Build input: filter out system (it goes in system_instructions), flatten rest
    let systemText: string | undefined;
    const inputMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const msg of req.messages) {
      if (msg.role === "system") {
        systemText = msg.content;
        continue;
      }
      if (msg.role === "tool") {
        // Tool results: format as user message for Responses API
        const parts = msg.content
          .filter((c) => c.type === "tool_result")
          .map((c) =>
            c.type === "tool_result"
              ? `[tool_result:${c.toolCallId}] ${typeof c.output === "string" ? c.output : JSON.stringify(c.output)}`
              : "",
          )
          .join("\n");
        inputMessages.push({ role: "user", content: parts });
        continue;
      }
      if (msg.role === "user") {
        const text = msg.content
          .filter((c) => c.type === "text")
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("\n");
        inputMessages.push({ role: "user", content: text || " " });
        continue;
      }
      if (msg.role === "assistant") {
        const text = msg.content
          .filter((c) => c.type === "text")
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("");
        if (text) inputMessages.push({ role: "assistant", content: text });
      }
    }

    // Build tools for Responses API
    type ResponsesTool = {
      type: "function";
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
    const responsesTools: ResponsesTool[] | undefined =
      req.tools && req.tools.length > 0
        ? req.tools.map((t) => ({
            type: "function" as const,
            name: t.name,
            description: t.description,
            parameters: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
          }))
        : undefined;

    try {
      // responses.create may not exist on all SDK versions; graceful fallback
      type ResponsesAPI = {
        create: (
          params: Record<string, unknown>,
        ) => Promise<AsyncIterable<Record<string, unknown>>>;
      };
      const responsesApi = (this.client as unknown as { responses?: ResponsesAPI }).responses;
      if (!responsesApi) {
        yield {
          type: "error",
          error: {
            code: "E_PROVIDER",
            message:
              "OpenAI Responses API not available in this SDK version. Use protocol: 'chat' instead.",
          },
        };
        return;
      }

      const params: Record<string, unknown> = {
        model: this.model,
        input: inputMessages,
        stream: true,
        ...(systemText !== undefined ? { instructions: systemText } : {}),
        ...(responsesTools !== undefined ? { tools: responsesTools } : {}),
        ...(req.maxOutputTokens !== undefined ? { max_output_tokens: req.maxOutputTokens } : {}),
      };

      const stream = await responsesApi.create(params);

      let finishReason: string | null = null;
      let currentToolCallId: string | undefined;
      let currentToolName: string | undefined;

      for await (const event of stream) {
        if (req.signal?.aborted) return;

        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation for Record<string, unknown>
        const evType = event["type"] as string | undefined;

        if (evType === "response.output_text.delta") {
          // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
          const delta = event["delta"] as string | undefined;
          if (delta) yield { type: "text_delta", text: delta };
        } else if (evType === "response.output_item.added") {
          // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
          const item = event["item"] as Record<string, unknown> | undefined;
          // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
          if (item?.["type"] === "function_call") {
            // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
            const callId = item["call_id"] as string;
            // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
            const name = item["name"] as string;
            currentToolCallId = callId;
            currentToolName = name;
            callIdToName.set(callId, name);
            yield { type: "tool_call_start", toolCallId: callId, name };
          }
        } else if (evType === "response.function_call_arguments.delta") {
          // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
          const delta = event["delta"] as string | undefined;
          if (delta && currentToolCallId) {
            yield { type: "tool_call_input_delta", toolCallId: currentToolCallId, partial: delta };
          }
        } else if (evType === "response.function_call_arguments.done") {
          if (currentToolCallId) {
            yield { type: "tool_call_end", toolCallId: currentToolCallId };
            currentToolCallId = undefined;
            currentToolName = undefined;
          }
        } else if (evType === "response.completed") {
          // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
          const response = event["response"] as Record<string, unknown> | undefined;
          // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
          finishReason = (response?.["status"] as string | undefined) ?? "end_turn";
          // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
          const usage = response?.["usage"] as Record<string, number> | undefined;
          if (usage) {
            // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
            inputTokens = usage["input_tokens"] ?? 0;
            // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
            outputTokens = usage["output_tokens"] ?? 0;
          }
        }
      }

      const usd =
        (inputTokens * (this.capabilities.claimed.costPerMtokIn ?? 0) +
          outputTokens * (this.capabilities.claimed.costPerMtokOut ?? 0)) /
        1_000_000;

      const stopReason: ProviderStopReason =
        finishReason === "completed" || finishReason === "end_turn"
          ? "end_turn"
          : finishReason === "max_output_tokens"
            ? "max_tokens"
            : callIdToName.size > 0
              ? "tool_use"
              : "end_turn";

      // Suppress unused variable warning
      void currentToolName;

      yield {
        type: "stop",
        reason: stopReason,
        usage: {
          tokensIn: inputTokens,
          tokensOut: outputTokens,
          wallMs: Date.now() - startMs,
          toolCalls: callIdToName.size,
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
    // Client-side estimation: character / 4 heuristic (a common approximation).
    // tiktoken would be more precise but adds a native dependency; for now we use
    // this heuristic with a clear comment. Accuracy is ~±20% for English text.
    let chars = 0;
    for (const m of messages) {
      if (m.role === "system") {
        chars += m.content.length;
      } else {
        for (const c of m.content) {
          if (c.type === "text") chars += c.text.length;
          else if (c.type === "tool_use") chars += JSON.stringify(c.input).length;
          else if (c.type === "tool_result") chars += JSON.stringify(c.output).length;
        }
      }
    }
    // Add ~4 tokens per message for role/format overhead
    const overhead = messages.length * 4;
    return { ok: true, value: Math.ceil(chars / 4) + overhead };
  }
}
