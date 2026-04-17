/**
 * Provider — a model adapter.
 *
 * The kernel never speaks to a vendor SDK directly. It speaks to a Provider.
 * Providers stream tokens, expose tool-use, and self-describe their
 * capabilities so the router and surveillance can reason about them.
 */

import type { BudgetUsage, Confidence, ContractError, Result } from "./common.js";

export type ProviderId = string;

/**
 * Capability descriptor — what a provider claims it can do, plus the
 * surveillance-observed envelope of what it has *actually* been doing.
 *
 * `claimed` is static (from configuration / the vendor's docs).
 * `observed` is updated by the surveillance module over the session's lifetime.
 */
export interface ProviderCapabilities {
  readonly id: ProviderId;
  readonly claimed: ClaimedCapabilities;
  readonly observed?: ObservedCapabilities;
}

export interface ClaimedCapabilities {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly nativeToolUse: boolean;
  readonly streamingToolUse: boolean;
  readonly vision: boolean;
  readonly audio: boolean;
  readonly thinking: boolean;
  readonly latencyTier: "interactive" | "batch";
  /** USD per 1M input/output tokens, if known. */
  readonly costPerMtokIn?: number;
  readonly costPerMtokOut?: number;
}

export interface ObservedCapabilities {
  /** Rolling success rate on calibrated probes, [0, 1]. */
  readonly probeSuccessRate?: Confidence;
  /** Median p50 wall time per call, ms. */
  readonly p50Ms?: number;
  /** Rolling tool-error rate. */
  readonly toolErrorRate?: number;
  /** When `observed` was last updated. */
  readonly lastUpdatedAt?: number;
}

/**
 * A normalized message in the provider's chat history.
 * Providers are responsible for translating to/from their native shapes.
 */
export type ProviderMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: ProviderContent[] }
  | { role: "assistant"; content: ProviderContent[] }
  | { role: "tool"; toolCallId: string; content: ProviderContent[] };

export type ProviderContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolCallId: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; output: unknown; isError?: boolean }
  | { type: "image"; mediaType: string; data: string }
  | { type: "thinking"; text: string };

export interface ProviderToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input. */
  readonly inputSchema: unknown;
}

export interface ProviderRequest {
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly ProviderToolSpec[];
  /** Hard cap on output tokens for this call. */
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  /** Opaque routing hint (e.g. "needs-vision", "fast"). */
  readonly hint?: string;
  /** AbortSignal for caller cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Streaming events. Providers emit one stream per call.
 */
export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; toolCallId: string; name: string }
  | { type: "tool_call_input_delta"; toolCallId: string; partial: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "stop"; reason: ProviderStopReason; usage: BudgetUsage }
  | { type: "error"; error: ContractError };

export type ProviderStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "refusal"
  | "error";

/**
 * The Provider contract.
 *
 * Implementations MUST:
 *   - emit a terminal `stop` (or `error`) event exactly once per call
 *   - honor `signal` cancellation; abort cleanly without leaking sockets
 *   - report usage on `stop` events even when output is empty
 *
 * Implementations SHOULD:
 *   - update `observed` capabilities passively from their own stats
 *   - prefer streaming tool-use when claimed
 */
export interface Provider {
  readonly capabilities: ProviderCapabilities;

  /**
   * Run a single request. Returns an async iterable of events.
   * The iterable MUST end after a terminal `stop` or `error` event.
   */
  invoke(req: ProviderRequest): AsyncIterable<ProviderEvent>;

  /**
   * Cheap, side-effect-free counting. Used by the kernel to stay under
   * the context window and to estimate budgets before calls.
   */
  countTokens(messages: readonly ProviderMessage[]): Promise<Result<number>>;
}
