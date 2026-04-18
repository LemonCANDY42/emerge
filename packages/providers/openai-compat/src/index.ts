/**
 * OpenAICompatProvider — thin wrapper around OpenAIProvider for OpenAI-compatible
 * local/self-hosted endpoints.
 *
 * Use this for:
 *   - Ollama       (http://localhost:11434/v1)
 *   - vLLM         (http://localhost:8000/v1)
 *   - llama.cpp    (http://localhost:8080/v1)
 *   - LM Studio    (http://localhost:1234/v1)
 *   - OpenRouter   (https://openrouter.ai/api/v1)
 *   - Your own custom OpenAI-compatible service
 *
 * The `name` field becomes the ProviderId — mount multiple services without collision:
 *   kernel.mountProvider(new OpenAICompatProvider({ name: "ollama", ... }))
 *   kernel.mountProvider(new OpenAICompatProvider({ name: "vllm-worker", ... }))
 *
 * Re-exports openaiSchemaAdapter for convenience.
 */

export { openaiSchemaAdapter } from "@emerge/provider-openai";
export { OpenAIProvider } from "@emerge/provider-openai";
export type { OpenAIProviderConfig, OpenAIProtocol } from "@emerge/provider-openai";

import type { ClaimedCapabilities, Provider, ProviderCapabilities } from "@emerge/kernel/contracts";
import { OpenAIProvider } from "@emerge/provider-openai";
import type { OpenAIProtocol } from "@emerge/provider-openai";

export interface OpenAICompatConfig {
  /**
   * Name for this service — becomes the ProviderId (e.g. "ollama", "vllm", "my-service").
   * Use unique names when mounting multiple custom services in the same Kernel.
   */
  readonly name: string;
  /** Base URL of the OpenAI-compatible endpoint. Required. */
  readonly baseURL: string;
  /** API key (optional; many local services do not require one). */
  readonly apiKey?: string;
  /** Model name to pass in API requests. Required. */
  readonly model: string;
  /**
   * "chat"      — chat.completions.create (default, most compatible)
   * "responses" — responses.create (newer Responses API; fewer services support it)
   */
  readonly protocol?: OpenAIProtocol;
  /**
   * Extra HTTP headers — useful for OpenRouter routing headers, auth proxies, etc.
   * Example: { "HTTP-Referer": "https://my-app.com", "X-Title": "My App" }
   */
  readonly extraHeaders?: Record<string, string>;
  /**
   * Override claimed capabilities. Useful when you know your local service's context
   * window or cost structure. Partial — omitted fields use conservative defaults.
   */
  readonly capabilities?: Partial<ClaimedCapabilities>;
}

const DEFAULT_CONSERVATIVE_CAPABILITIES: ClaimedCapabilities = {
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  nativeToolUse: true,
  streamingToolUse: true,
  vision: false,
  audio: false,
  thinking: false,
  latencyTier: "interactive",
};

/**
 * A thin specialization of OpenAIProvider pre-configured for OpenAI-compatible services.
 *
 * The `name` field becomes the ProviderId, allowing multiple compat services in one Kernel.
 */
export class OpenAICompatProvider implements Provider {
  readonly capabilities: ProviderCapabilities;
  private readonly inner: OpenAIProvider;

  constructor(config: OpenAICompatConfig) {
    this.inner = new OpenAIProvider({
      apiKey: config.apiKey ?? "no-key",
      model: config.model,
      baseURL: config.baseURL,
      protocol: config.protocol ?? "chat",
      ...(config.extraHeaders !== undefined ? { extraHeaders: config.extraHeaders } : {}),
    });

    // Merge conservative defaults with any caller-supplied overrides
    const claimed: ClaimedCapabilities = {
      ...DEFAULT_CONSERVATIVE_CAPABILITIES,
      ...config.capabilities,
    };

    this.capabilities = {
      id: config.name,
      claimed,
    };
  }

  invoke(
    req: import("@emerge/kernel/contracts").ProviderRequest,
  ): AsyncIterable<import("@emerge/kernel/contracts").ProviderEvent> {
    return this.inner.invoke(req);
  }

  countTokens(
    messages: readonly import("@emerge/kernel/contracts").ProviderMessage[],
  ): Promise<import("@emerge/kernel/contracts").Result<number>> {
    return this.inner.countTokens(messages);
  }
}
