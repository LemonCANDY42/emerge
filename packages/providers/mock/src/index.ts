/**
 * MockProvider — scripted provider for tests/demos without API keys.
 * M3b: also exports the recommended schema adapter for mock providers.
 * Since MockProvider mimics a generic scripted interface, it uses the
 * default (no-op) adapter — real adapters live in the vendor provider packages.
 *
 * M2 additions:
 *   - Accepts `tier` to select reproducibility behaviour.
 *   - When `tier === "pinned"`, maintains a pinned-outcome map keyed by
 *     (messages hash, tools hash). Divergence recording is wired but is a
 *     no-op on the deterministic mock (same key always produces the same
 *     script entry).
 */

import type {
  Divergence,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  ReproducibilityTier,
  Result,
} from "@lwrf42/emerge-kernel/contracts";
export { defaultAdapter as mockSchemaAdapter } from "@lwrf42/emerge-kernel/runtime";

export interface MockScriptEntry {
  /** Events emitted in order for this call. */
  readonly events: readonly ProviderEvent[];
}

export interface MockProviderConfig {
  readonly id?: string;
  readonly tier?: ReproducibilityTier;
  readonly divergenceSink?: (d: Divergence) => void;
}

/** Simple djb2-style hash for the pinned-outcome key (no node:crypto needed). */
function simpleHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ (s.charCodeAt(i) | 0);
    h |= 0; // keep 32-bit
  }
  return h >>> 0;
}

/** Key for the pinned-outcome map. */
function hashKey(messages: readonly ProviderMessage[], tools?: readonly unknown[]): string {
  const msgHash = simpleHash(JSON.stringify(messages)).toString(16);
  const toolHash = simpleHash(JSON.stringify(tools ?? [])).toString(16);
  return `${msgHash}:${toolHash}`;
}

export class MockProvider implements Provider {
  readonly capabilities: ProviderCapabilities;
  private readonly script: readonly MockScriptEntry[];
  private readonly tier: ReproducibilityTier;
  private readonly divergenceSink: ((d: Divergence) => void) | undefined;
  /** Number of times invoke() has been called. Public for replay assertions. */
  callIndex = 0;
  /** Pinned-outcome map: (messages hash + tools hash) → script index at pin time. */
  private readonly pinnedOutcomes = new Map<string, number>();

  constructor(
    script: readonly MockScriptEntry[],
    idOrConfig: string | MockProviderConfig = "mock",
  ) {
    this.script = script;
    if (typeof idOrConfig === "string") {
      this.tier = "free";
      this.divergenceSink = undefined;
      this.capabilities = {
        id: idOrConfig,
        claimed: {
          contextWindow: 200_000,
          maxOutputTokens: 8192,
          nativeToolUse: true,
          streamingToolUse: true,
          vision: false,
          audio: false,
          thinking: false,
          latencyTier: "interactive",
        },
      };
    } else {
      this.tier = idOrConfig.tier ?? "free";
      this.divergenceSink = idOrConfig.divergenceSink;
      this.capabilities = {
        id: idOrConfig.id ?? "mock",
        claimed: {
          contextWindow: 200_000,
          maxOutputTokens: 8192,
          nativeToolUse: true,
          streamingToolUse: true,
          vision: false,
          audio: false,
          thinking: false,
          latencyTier: "interactive",
        },
      };
    }
  }

  async *invoke(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const index = this.callIndex % this.script.length;

    if (this.tier === "pinned") {
      const key = hashKey(req.messages, req.tools);
      const pinnedIndex = this.pinnedOutcomes.get(key);
      if (pinnedIndex !== undefined && pinnedIndex !== index) {
        // Record divergence — deterministic mock never actually diverges, but
        // the API is wired for compliance with the contract.
        this.divergenceSink?.({
          at: Date.now(),
          providerId: this.capabilities.id,
          tier: "pinned",
          category: "stop_reason",
          expectedHash: String(pinnedIndex),
          actualHash: String(index),
          note: "MockProvider pinned-outcome index mismatch (unexpected in deterministic mock)",
        });
      } else {
        this.pinnedOutcomes.set(key, index);
      }
    }

    const entry = this.script[index];
    this.callIndex++;

    if (!entry) {
      yield {
        type: "stop",
        reason: "end_turn",
        usage: { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
      };
      return;
    }

    for (const event of entry.events) {
      if (req.signal?.aborted) return;
      yield event;
    }

    // Ensure stop event exists
    const hasStop = entry.events.some((e) => e.type === "stop" || e.type === "error");
    if (!hasStop) {
      yield {
        type: "stop",
        reason: "end_turn",
        usage: { tokensIn: 0, tokensOut: 0, wallMs: 1, toolCalls: 0, usd: 0 },
      };
    }
  }

  async countTokens(messages: readonly ProviderMessage[]): Promise<Result<number>> {
    let chars = 0;
    for (const m of messages) {
      if (typeof m.content === "string") {
        chars += m.content.length;
      } else {
        for (const c of m.content) {
          if (c.type === "text") chars += c.text.length;
          else if (c.type === "tool_use") chars += JSON.stringify(c.input).length;
          else if (c.type === "tool_result") chars += JSON.stringify(c.output).length;
        }
      }
    }
    return { ok: true, value: Math.ceil(chars / 4) };
  }
}
