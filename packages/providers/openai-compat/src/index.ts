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
 *
 * ## extraParams
 * Some gateways expose non-standard parameters (e.g. custom thinking knobs,
 * routing hints, temperature overrides). Pass them via `extraParams` and they
 * will be merged into every `responses.create` / `chat.completions.create` call.
 *
 * Example:
 *   new OpenAICompatProvider({
 *     name: "my-gateway",
 *     baseURL: "https://api.my-gateway.com",
 *     model: "gpt-5.4",
 *     protocol: "responses",
 *     extraParams: { reasoning_effort: "high", custom_field: true },
 *   })
 */

export { openaiSchemaAdapter } from "@lwrf42/emerge-provider-openai";
export { OpenAIProvider } from "@lwrf42/emerge-provider-openai";
export type {
  OpenAIProviderConfig,
  OpenAIProtocol,
  OpenAIReasoningConfig,
  RetryOptions,
} from "@lwrf42/emerge-provider-openai";

import type {
  ClaimedCapabilities,
  Provider,
  ProviderCapabilities,
} from "@lwrf42/emerge-kernel/contracts";
import { OpenAIProvider } from "@lwrf42/emerge-provider-openai";
import type {
  OpenAIProtocol,
  OpenAIReasoningConfig,
  RetryOptions,
} from "@lwrf42/emerge-provider-openai";

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
  /**
   * Retry-on-5xx configuration. Set to `false` to disable all retries.
   * Default: 3 attempts, 500ms initial delay, 10s cap, with jitter.
   */
  readonly retry?: RetryOptions | false;
  /**
   * Reasoning configuration for gateways that support OpenAI-style reasoning knobs.
   * Mirrors the OpenAI provider's `reasoning` option — forwarded verbatim.
   *
   * Environment variable mirror: EMERGE_LLM_REASONING_EFFORT
   */
  readonly reasoning?: OpenAIReasoningConfig;
  /**
   * Extra parameters to merge into every API call (responses.create or
   * chat.completions.create). Useful for gateway-specific extensions such as
   * custom thinking controls, routing hints, or non-standard temperature fields.
   *
   * These are passed through verbatim — the gateway is responsible for
   * accepting or ignoring unknown fields. If the gateway rejects a field,
   * the error will surface as a provider error event.
   *
   * Example:
   *   extraParams: { reasoning_effort: "high", x_gateway_hint: "fast" }
   */
  readonly extraParams?: Record<string, unknown>;
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
    // Merge conservative defaults with any caller-supplied overrides before passing to inner.
    const claimed: ClaimedCapabilities = {
      ...DEFAULT_CONSERVATIVE_CAPABILITIES,
      ...config.capabilities,
    };

    // Resolve reasoning from config or env var EMERGE_LLM_REASONING_EFFORT
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    const reasoningEnv = process.env["EMERGE_LLM_REASONING_EFFORT"] as
      | OpenAIReasoningConfig["effort"]
      | undefined;

    const reasoning: OpenAIReasoningConfig | undefined =
      config.reasoning !== undefined
        ? config.reasoning
        : reasoningEnv !== undefined
          ? { effort: reasoningEnv }
          : undefined;

    // C4: pass cost overrides into the inner OpenAIProvider so the USD calculation uses
    // the caller-supplied rates rather than defaults (which would be zero for custom URLs).
    this.inner = new OpenAIProvider({
      apiKey: config.apiKey ?? "no-key",
      model: config.model,
      baseURL: config.baseURL,
      protocol: config.protocol ?? "chat",
      ...(config.extraHeaders !== undefined ? { extraHeaders: config.extraHeaders } : {}),
      ...(claimed.costPerMtokIn !== undefined ? { costPerMtokIn: claimed.costPerMtokIn } : {}),
      ...(claimed.costPerMtokOut !== undefined ? { costPerMtokOut: claimed.costPerMtokOut } : {}),
      ...(config.retry !== undefined ? { retry: config.retry } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(config.extraParams !== undefined ? { extraParams: config.extraParams } : {}),
    });

    this.capabilities = {
      id: config.name,
      claimed,
    };
  }

  invoke(
    req: import("@lwrf42/emerge-kernel/contracts").ProviderRequest,
  ): AsyncIterable<import("@lwrf42/emerge-kernel/contracts").ProviderEvent> {
    return this.inner.invoke(req);
  }

  countTokens(
    messages: readonly import("@lwrf42/emerge-kernel/contracts").ProviderMessage[],
  ): Promise<import("@lwrf42/emerge-kernel/contracts").Result<number>> {
    return this.inner.countTokens(messages);
  }
}
