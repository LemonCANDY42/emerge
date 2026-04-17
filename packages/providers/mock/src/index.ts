/**
 * MockProvider — scripted provider for tests/demos without API keys.
 */

import type {
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  Result,
} from "@emerge/kernel/contracts";

export interface MockScriptEntry {
  /** Events emitted in order for this call. */
  readonly events: readonly ProviderEvent[];
}

export class MockProvider implements Provider {
  readonly capabilities: ProviderCapabilities;
  private readonly script: readonly MockScriptEntry[];
  /** Number of times invoke() has been called. Public for replay assertions. */
  callIndex = 0;

  constructor(script: readonly MockScriptEntry[], id = "mock") {
    this.script = script;
    this.capabilities = {
      id,
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

  async *invoke(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const entry = this.script[this.callIndex % this.script.length];
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
