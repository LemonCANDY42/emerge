/**
 * Retry helper tests for the Anthropic provider.
 *
 * All tests use an injected no-op sleep so there are no real delays —
 * the suite is fully deterministic.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY_OPTIONS, computeDelay, isRetriable, withRetry } from "./retry.js";
import type { RetryOptions } from "./retry.js";

// ---------------------------------------------------------------------------
// isRetriable
// ---------------------------------------------------------------------------

describe("isRetriable (anthropic)", () => {
  it("returns true for HTTP 502 via .statusCode (Anthropic SDK convention)", () => {
    const err = Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for HTTP 429 via .statusCode", () => {
    const err = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for HTTP 500 via .statusCode", () => {
    const err = Object.assign(new Error("Internal Server Error"), { statusCode: 500 });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for HTTP 503 via .statusCode", () => {
    const err = Object.assign(new Error("Service Unavailable"), { statusCode: 503 });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for HTTP 504 via .statusCode", () => {
    const err = Object.assign(new Error("Gateway Timeout"), { statusCode: 504 });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for ECONNRESET node error", () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for ETIMEDOUT node error", () => {
    const err = Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns false for HTTP 400 (bad request)", () => {
    const err = Object.assign(new Error("Bad Request"), { statusCode: 400 });
    expect(isRetriable(err)).toBe(false);
  });

  it("returns false for HTTP 401 (unauthorized)", () => {
    const err = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    expect(isRetriable(err)).toBe(false);
  });

  it("returns false for HTTP 403 (forbidden)", () => {
    const err = Object.assign(new Error("Forbidden"), { statusCode: 403 });
    expect(isRetriable(err)).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isRetriable(null)).toBe(false);
    expect(isRetriable("oops")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeDelay
// ---------------------------------------------------------------------------

describe("computeDelay (anthropic)", () => {
  const opts: RetryOptions = {
    maxAttempts: 3,
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitter: false,
  };

  it("returns initialDelayMs for attempt 1", () => {
    expect(computeDelay(opts, 1)).toBe(500);
  });

  it("doubles for attempt 2", () => {
    expect(computeDelay(opts, 2)).toBe(1000);
  });

  it("caps at maxDelayMs", () => {
    const cap: RetryOptions = { ...opts, initialDelayMs: 1000, maxDelayMs: 1500 };
    expect(computeDelay(cap, 2)).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry (anthropic)", () => {
  const noSleep = async (_ms: number) => {};

  it("returns immediately on success", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      DEFAULT_RETRY_OPTIONS,
      "anthropic",
      noSleep,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on 502 (statusCode) and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
        return "recovered";
      },
      DEFAULT_RETRY_OPTIONS,
      "anthropic",
      noSleep,
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("throws after exhausting maxAttempts on persistent 502", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
        },
        DEFAULT_RETRY_OPTIONS,
        "anthropic",
        noSleep,
      ),
    ).rejects.toThrow("Bad Gateway");
    expect(calls).toBe(DEFAULT_RETRY_OPTIONS.maxAttempts);
  });

  it("does NOT retry on 401", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
        },
        DEFAULT_RETRY_OPTIONS,
        "anthropic",
        noSleep,
      ),
    ).rejects.toThrow("Unauthorized");
    expect(calls).toBe(1);
  });

  it("does NOT retry when retry is false", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
        },
        false,
        "anthropic",
        noSleep,
      ),
    ).rejects.toThrow("Bad Gateway");
    expect(calls).toBe(1);
  });

  it("sleeps between retries", async () => {
    const sleepCalls: number[] = [];
    const trackSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };
    let calls = 0;
    const opts: RetryOptions = {
      maxAttempts: 3,
      initialDelayMs: 200,
      maxDelayMs: 10_000,
      jitter: false,
    };
    await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
        return "ok";
      },
      opts,
      "anthropic",
      trackSleep,
    );
    expect(sleepCalls).toHaveLength(2);
    expect(sleepCalls[0]).toBe(200);
    expect(sleepCalls[1]).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// AnthropicProvider — integration: retry via injected sleep
// ---------------------------------------------------------------------------

describe("AnthropicProvider retry integration", () => {
  it("retries when client.messages.create throws 502 then succeeds", async () => {
    const { AnthropicProvider } = await import("./index.js");

    const noSleep = async (_ms: number) => {};
    const provider = new AnthropicProvider(
      {
        apiKey: "test-key",
        model: "claude-3-5-haiku-20241022",
        retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 1000, jitter: false },
      },
      noSleep,
    );

    let callCount = 0;
    const fakeStream = async function* () {
      yield { type: "message_start", message: { usage: { input_tokens: 10 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } };
      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      };
    };

    (
      provider as unknown as {
        client: { messages: { create: () => unknown } };
      }
    ).client.messages.create = async () => {
      callCount++;
      if (callCount < 2) throw Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
      return fakeStream();
    };

    const events: unknown[] = [];
    for await (const ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })) {
      events.push(ev);
    }

    expect(callCount).toBe(2);
    expect(events.some((e) => (e as { type: string }).type === "text_delta")).toBe(true);
    expect(events.some((e) => (e as { type: string }).type === "stop")).toBe(true);
  });

  it("does NOT retry when retry: false", async () => {
    const { AnthropicProvider } = await import("./index.js");

    const noSleep = async (_ms: number) => {};
    const provider = new AnthropicProvider(
      {
        apiKey: "test-key",
        model: "claude-3-5-haiku-20241022",
        retry: false,
      },
      noSleep,
    );

    let callCount = 0;
    (
      provider as unknown as {
        client: { messages: { create: () => unknown } };
      }
    ).client.messages.create = async () => {
      callCount++;
      throw Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
    };

    const events: unknown[] = [];
    for await (const ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })) {
      events.push(ev);
    }

    expect(callCount).toBe(1);
    expect(events.some((e) => (e as { type: string }).type === "error")).toBe(true);
  });

  it("does NOT retry mid-stream errors — only stream creation is wrapped", async () => {
    const { AnthropicProvider } = await import("./index.js");

    const noSleep = async (_ms: number) => {};
    const provider = new AnthropicProvider(
      {
        apiKey: "test-key",
        model: "claude-3-5-haiku-20241022",
        retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 1000, jitter: false },
      },
      noSleep,
    );

    let createCount = 0;
    const fakeStream = async function* () {
      yield { type: "message_start", message: { usage: { input_tokens: 10 } } };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" },
      };
      // throw mid-stream
      throw Object.assign(new Error("mid-stream 502"), { statusCode: 502 });
    };

    (
      provider as unknown as {
        client: { messages: { create: () => unknown } };
      }
    ).client.messages.create = async () => {
      createCount++;
      return fakeStream();
    };

    const events: unknown[] = [];
    for await (const ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })) {
      events.push(ev);
    }

    // stream creation was called only once — mid-stream errors are not retried
    expect(createCount).toBe(1);
    expect(events.some((e) => (e as { type: string }).type === "text_delta")).toBe(true);
    expect(events.some((e) => (e as { type: string }).type === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AnthropicProvider — thinking config
// ---------------------------------------------------------------------------

describe("AnthropicProvider thinking config", () => {
  it("injects thinking param when thinking is enabled", async () => {
    const { AnthropicProvider } = await import("./index.js");

    const capturedParams: Record<string, unknown>[] = [];
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-3-7-sonnet-20250219",
      retry: false,
      thinking: { type: "enabled", budget_tokens: 8192 },
    });

    const fakeStream = async function* () {
      yield { type: "message_start", message: { usage: { input_tokens: 10 } } };
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "I am thinking..." },
      };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } };
      yield {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "answer" },
      };
      yield { type: "content_block_stop", index: 1 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 20 },
      };
    };

    (
      provider as unknown as {
        client: { messages: { create: (p: Record<string, unknown>) => unknown } };
      }
    ).client.messages.create = async (params) => {
      capturedParams.push(params);
      return fakeStream();
    };

    const events: unknown[] = [];
    for await (const ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
    })) {
      events.push(ev);
    }

    // The thinking param should be in the params
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    expect(capturedParams[0]?.["thinking"]).toEqual({ type: "enabled", budget_tokens: 8192 });

    // thinking_delta events should be emitted
    const thinkingEvents = events.filter((e) => (e as { type: string }).type === "thinking_delta");
    expect(thinkingEvents.length).toBeGreaterThan(0);
    expect((thinkingEvents[0] as { text: string }).text).toBe("I am thinking...");

    // text_delta should also be present
    expect(events.some((e) => (e as { type: string }).type === "text_delta")).toBe(true);
  });

  it("does NOT inject thinking param when thinking is disabled", async () => {
    const { AnthropicProvider } = await import("./index.js");

    const capturedParams: Record<string, unknown>[] = [];
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-3-5-haiku-20241022",
      retry: false,
      thinking: { type: "disabled" },
    });

    const fakeStream = async function* () {
      yield { type: "message_start", message: { usage: { input_tokens: 5 } } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      };
    };

    (
      provider as unknown as {
        client: { messages: { create: (p: Record<string, unknown>) => unknown } };
      }
    ).client.messages.create = async (params) => {
      capturedParams.push(params);
      return fakeStream();
    };

    for await (const _ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })) {
      // drain
    }

    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    expect(capturedParams[0]?.["thinking"]).toBeUndefined();
  });

  it("sets thinking=true in capabilities when thinking is enabled", async () => {
    const { AnthropicProvider } = await import("./index.js");

    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-3-7-sonnet-20250219",
      thinking: { type: "enabled", budget_tokens: 4096 },
    });

    expect(provider.capabilities.claimed.thinking).toBe(true);
  });

  it("keeps thinking=false in capabilities when thinking is disabled", async () => {
    const { AnthropicProvider } = await import("./index.js");

    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-3-5-haiku-20241022",
    });

    expect(provider.capabilities.claimed.thinking).toBe(false);
  });
});
