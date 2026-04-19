/**
 * Retry helper tests for the OpenAI provider.
 *
 * All tests use an injected no-op sleep (or tracked sleep) so there are no
 * real delays — the suite is fully deterministic.
 */

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRY_OPTIONS, computeDelay, isRetriable, withRetry } from "./retry.js";
import type { RetryOptions } from "./retry.js";

// ---------------------------------------------------------------------------
// isRetriable
// ---------------------------------------------------------------------------

describe("isRetriable", () => {
  it("returns true for HTTP 502 via .status (OpenAI SDK convention)", () => {
    const err = Object.assign(new Error("Bad Gateway"), { status: 502 });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for HTTP 502 via .statusCode (Anthropic SDK convention)", () => {
    const err = Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for HTTP 429 (rate limit)", () => {
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for HTTP 500", () => {
    const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for HTTP 503", () => {
    const err = Object.assign(new Error("Service Unavailable"), { status: 503 });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for HTTP 504", () => {
    const err = Object.assign(new Error("Gateway Timeout"), { status: 504 });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for HTTP 408 (request timeout)", () => {
    const err = Object.assign(new Error("Request Timeout"), { status: 408 });
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

  it("returns true for ECONNREFUSED node error", () => {
    const err = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns true for EAI_AGAIN node error", () => {
    const err = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    expect(isRetriable(err)).toBe(true);
  });

  it("returns false for HTTP 400 (bad request — deterministic failure)", () => {
    const err = Object.assign(new Error("Bad Request"), { status: 400 });
    expect(isRetriable(err)).toBe(false);
  });

  it("returns false for HTTP 401 (unauthorized)", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(isRetriable(err)).toBe(false);
  });

  it("returns false for HTTP 404 (not found)", () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    expect(isRetriable(err)).toBe(false);
  });

  it("returns false for HTTP 422 (unprocessable entity)", () => {
    const err = Object.assign(new Error("Unprocessable Entity"), { status: 422 });
    expect(isRetriable(err)).toBe(false);
  });

  it("returns false for HTTP 413 (payload too large)", () => {
    const err = Object.assign(new Error("Payload Too Large"), { status: 413 });
    expect(isRetriable(err)).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isRetriable("some string")).toBe(false);
    expect(isRetriable(null)).toBe(false);
    expect(isRetriable(42)).toBe(false);
  });

  it("returns true for message heuristic '502'", () => {
    const err = new Error("Cloudflare returned 502 Bad Gateway");
    expect(isRetriable(err)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeDelay
// ---------------------------------------------------------------------------

describe("computeDelay", () => {
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

  it("doubles again for attempt 3", () => {
    expect(computeDelay(opts, 3)).toBe(2000);
  });

  it("caps at maxDelayMs", () => {
    const cap: RetryOptions = { ...opts, initialDelayMs: 1000, maxDelayMs: 3000 };
    // attempt 3 → 1000 * 4 = 4000, capped at 3000
    expect(computeDelay(cap, 3)).toBe(3000);
  });

  it("with jitter produces a value in [0.8x, 1.2x] range", () => {
    const jitterOpts: RetryOptions = { ...opts, jitter: true };
    const base = 500; // attempt 1
    for (let i = 0; i < 20; i++) {
      const d = computeDelay(jitterOpts, 1);
      expect(d).toBeGreaterThanOrEqual(Math.round(base * 0.8));
      expect(d).toBeLessThanOrEqual(Math.round(base * 1.2));
    }
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  const noSleep = async (_ms: number) => {}; // deterministic — no real delay

  it("returns immediately on success without retrying", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return "ok";
    };
    const result = await withRetry(fn, DEFAULT_RETRY_OPTIONS, "openai", noSleep);
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on 502 and succeeds on second attempt", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      return "success";
    };
    const result = await withRetry(fn, DEFAULT_RETRY_OPTIONS, "openai", noSleep);
    expect(result).toBe("success");
    expect(calls).toBe(2);
  });

  it("retries on 502 twice then succeeds on third attempt (maxAttempts=3)", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      return "done";
    };
    const result = await withRetry(fn, DEFAULT_RETRY_OPTIONS, "openai", noSleep);
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  it("throws after exhausting maxAttempts", async () => {
    let calls = 0;
    const err502 = Object.assign(new Error("Bad Gateway"), { status: 502 });
    const fn = async () => {
      calls++;
      throw err502;
    };
    await expect(withRetry(fn, DEFAULT_RETRY_OPTIONS, "openai", noSleep)).rejects.toThrow(
      "Bad Gateway",
    );
    expect(calls).toBe(DEFAULT_RETRY_OPTIONS.maxAttempts);
  });

  it("does NOT retry on 401 (non-retriable error)", async () => {
    let calls = 0;
    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });
    const fn = async () => {
      calls++;
      throw err401;
    };
    await expect(withRetry(fn, DEFAULT_RETRY_OPTIONS, "openai", noSleep)).rejects.toThrow(
      "Unauthorized",
    );
    expect(calls).toBe(1); // no retry
  });

  it("does NOT retry on 400 (bad request — deterministic)", async () => {
    let calls = 0;
    const err400 = Object.assign(new Error("Bad Request"), { status: 400 });
    const fn = async () => {
      calls++;
      throw err400;
    };
    await expect(withRetry(fn, DEFAULT_RETRY_OPTIONS, "openai", noSleep)).rejects.toThrow(
      "Bad Request",
    );
    expect(calls).toBe(1);
  });

  it("does NOT retry when retry is disabled (false)", async () => {
    let calls = 0;
    const err502 = Object.assign(new Error("Bad Gateway"), { status: 502 });
    const fn = async () => {
      calls++;
      throw err502;
    };
    await expect(withRetry(fn, false, "openai", noSleep)).rejects.toThrow("Bad Gateway");
    expect(calls).toBe(1);
  });

  it("calls sleep between retries", async () => {
    const sleepCalls: number[] = [];
    const trackSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    let calls = 0;
    const opts: RetryOptions = {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 10_000,
      jitter: false,
    };

    const fn = async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      return "ok";
    };

    await withRetry(fn, opts, "openai", trackSleep);
    // 2 failures → 2 sleep calls before 3rd success
    expect(sleepCalls).toHaveLength(2);
    expect(sleepCalls[0]).toBe(100); // attempt 1: initialDelayMs * 2^0 = 100
    expect(sleepCalls[1]).toBe(200); // attempt 2: initialDelayMs * 2^1 = 200
  });

  it("respects maxAttempts: 1 (no retries at all)", async () => {
    let calls = 0;
    const opts: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, maxAttempts: 1 };
    const fn = async () => {
      calls++;
      throw Object.assign(new Error("Bad Gateway"), { status: 502 });
    };
    await expect(withRetry(fn, opts, "openai", noSleep)).rejects.toThrow("Bad Gateway");
    expect(calls).toBe(1);
  });

  it("retries on ECONNRESET (network error)", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      return "recovered";
    };
    const result = await withRetry(fn, DEFAULT_RETRY_OPTIONS, "openai", noSleep);
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider — integration: retry via injected sleep
// ---------------------------------------------------------------------------

describe("OpenAIProvider retry integration", () => {
  it("retries invokeChat when stream creation throws 502 then succeeds", async () => {
    const { OpenAIProvider } = await import("./index.js");

    const noSleep = async (_ms: number) => {};
    const provider = new OpenAIProvider(
      {
        apiKey: "test-key",
        model: "gpt-4o",
        protocol: "chat",
        retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 1000, jitter: false },
      },
      noSleep,
    );

    let callCount = 0;
    // Patch the client to throw 502 once then yield a fake stream
    const fakeStream = async function* () {
      yield {
        choices: [{ delta: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    };

    (
      provider as unknown as {
        client: { chat: { completions: { create: () => unknown } } };
      }
    ).client.chat.completions.create = async () => {
      callCount++;
      if (callCount < 2) throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      return fakeStream();
    };

    const events: unknown[] = [];
    for await (const ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      events.push(ev);
    }

    expect(callCount).toBe(2); // one failure + one success
    expect(events.some((e) => (e as { type: string }).type === "text_delta")).toBe(true);
    expect(events.some((e) => (e as { type: string }).type === "stop")).toBe(true);
  });

  it("does NOT retry mid-stream errors — only stream-creation is wrapped", async () => {
    // This test documents the design decision: once we've started iterating the
    // stream, errors thrown DURING iteration are NOT retried. This prevents
    // duplicate events. The error is surfaced as a provider error event.
    const { OpenAIProvider } = await import("./index.js");

    const noSleep = async (_ms: number) => {};
    const provider = new OpenAIProvider(
      {
        apiKey: "test-key",
        model: "gpt-4o",
        protocol: "chat",
        retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 1000, jitter: false },
      },
      noSleep,
    );

    let createCount = 0;
    const fakeStream = async function* () {
      yield {
        choices: [{ delta: { content: "partial" }, finish_reason: null }],
        usage: null,
      };
      // Throw mid-stream after yielding one event
      throw Object.assign(new Error("mid-stream failure"), { status: 502 });
    };

    (
      provider as unknown as {
        client: { chat: { completions: { create: () => unknown } } };
      }
    ).client.chat.completions.create = async () => {
      createCount++;
      return fakeStream();
    };

    const events: unknown[] = [];
    for await (const ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      events.push(ev);
    }

    // Stream creation was only called once — no retry on mid-stream error
    expect(createCount).toBe(1);
    // Should have the text_delta then an error event (not a stop)
    expect(events.some((e) => (e as { type: string }).type === "text_delta")).toBe(true);
    expect(events.some((e) => (e as { type: string }).type === "error")).toBe(true);
  });

  it("does NOT retry when retry: false", async () => {
    const { OpenAIProvider } = await import("./index.js");

    const noSleep = async (_ms: number) => {};
    const provider = new OpenAIProvider(
      {
        apiKey: "test-key",
        model: "gpt-4o",
        protocol: "chat",
        retry: false,
      },
      noSleep,
    );

    let callCount = 0;
    (
      provider as unknown as {
        client: { chat: { completions: { create: () => unknown } } };
      }
    ).client.chat.completions.create = async () => {
      callCount++;
      throw Object.assign(new Error("Bad Gateway"), { status: 502 });
    };

    const events: unknown[] = [];
    for await (const ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      events.push(ev);
    }

    expect(callCount).toBe(1); // not retried
    expect(events.some((e) => (e as { type: string }).type === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider — reasoning config propagation
// ---------------------------------------------------------------------------

describe("OpenAIProvider reasoning config", () => {
  it("includes reasoning_effort in chat completions params when reasoning is set", async () => {
    const { OpenAIProvider } = await import("./index.js");

    const capturedParams: Record<string, unknown>[] = [];
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "o3-mini",
      protocol: "chat",
      retry: false,
      reasoning: { effort: "high" },
    });

    const fakeStream = async function* () {
      yield {
        choices: [{ delta: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      };
    };

    (
      provider as unknown as {
        client: { chat: { completions: { create: (p: Record<string, unknown>) => unknown } } };
      }
    ).client.chat.completions.create = async (params) => {
      capturedParams.push(params);
      return fakeStream();
    };

    for await (const _ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "think" }] }],
    })) {
      // drain
    }

    expect(capturedParams).toHaveLength(1);
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    expect(capturedParams[0]?.["reasoning_effort"]).toBe("high");
  });

  it("includes reasoning.effort in responses params when reasoning is set", async () => {
    const { OpenAIProvider } = await import("./index.js");

    const capturedParams: Record<string, unknown>[] = [];
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "gpt-5.4",
      protocol: "responses",
      retry: false,
      reasoning: { effort: "xhigh", summary: "concise" },
    });

    const fakeStream = async function* () {
      yield {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 10, output_tokens: 20 } },
      };
    };

    (
      provider as unknown as {
        client: { responses?: { create: (p: Record<string, unknown>) => unknown } };
      }
    ).client.responses = {
      create: async (params) => {
        capturedParams.push(params);
        return fakeStream();
      },
    };

    for await (const _ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "think hard" }] }],
    })) {
      // drain
    }

    expect(capturedParams).toHaveLength(1);
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    const reasoning = capturedParams[0]?.["reasoning"] as Record<string, unknown> | undefined;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    expect(reasoning?.["effort"]).toBe("xhigh");
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    expect(reasoning?.["summary"]).toBe("concise");
  });

  it("does NOT include reasoning params when reasoning is not set", async () => {
    const { OpenAIProvider } = await import("./index.js");

    const capturedParams: Record<string, unknown>[] = [];
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4o",
      protocol: "chat",
      retry: false,
    });

    const fakeStream = async function* () {
      yield {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      };
    };

    (
      provider as unknown as {
        client: { chat: { completions: { create: (p: Record<string, unknown>) => unknown } } };
      }
    ).client.chat.completions.create = async (params) => {
      capturedParams.push(params);
      return fakeStream();
    };

    for await (const _ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })) {
      // drain
    }

    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    expect(capturedParams[0]?.["reasoning_effort"]).toBeUndefined();
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    expect(capturedParams[0]?.["reasoning"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider — extraParams pass-through
// ---------------------------------------------------------------------------

describe("OpenAIProvider extraParams", () => {
  it("merges extraParams into chat completions call", async () => {
    const { OpenAIProvider } = await import("./index.js");

    const capturedParams: Record<string, unknown>[] = [];
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4o",
      protocol: "chat",
      retry: false,
      extraParams: { x_custom_field: "gateway-hint", another_param: 42 },
    });

    const fakeStream = async function* () {
      yield {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      };
    };

    (
      provider as unknown as {
        client: { chat: { completions: { create: (p: Record<string, unknown>) => unknown } } };
      }
    ).client.chat.completions.create = async (params) => {
      capturedParams.push(params);
      return fakeStream();
    };

    for await (const _ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })) {
      // drain
    }

    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    expect(capturedParams[0]?.["x_custom_field"]).toBe("gateway-hint");
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    expect(capturedParams[0]?.["another_param"]).toBe(42);
  });

  it("merges extraParams into responses create call", async () => {
    const { OpenAIProvider } = await import("./index.js");

    const capturedParams: Record<string, unknown>[] = [];
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "gpt-5.4",
      protocol: "responses",
      retry: false,
      extraParams: { gateway_mode: "fast" },
    });

    const fakeStream = async function* () {
      yield {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3 } },
      };
    };

    (
      provider as unknown as {
        client: { responses?: { create: (p: Record<string, unknown>) => unknown } };
      }
    ).client.responses = {
      create: async (params) => {
        capturedParams.push(params);
        return fakeStream();
      },
    };

    for await (const _ev of provider.invoke({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })) {
      // drain
    }

    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    expect(capturedParams[0]?.["gateway_mode"]).toBe("fast");
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider — baseURL path warning
// ---------------------------------------------------------------------------

describe("OpenAIProvider baseURL warning", () => {
  it("logs a warning when baseURL ends with /responses (endpoint path embedded)", async () => {
    const { OpenAIProvider } = await import("./index.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    new OpenAIProvider({ apiKey: "k", baseURL: "https://api.example.com/v1/responses" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("endpoint path"));

    warnSpy.mockRestore();
  });

  it("does NOT warn when baseURL ends with /v1 (correct for standard gateways)", async () => {
    const { OpenAIProvider } = await import("./index.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    new OpenAIProvider({ apiKey: "k", baseURL: "https://api.example.com/v1" });
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("warns when baseURL does not end with /v1 (missing /v1 for standard gateways)", async () => {
    const { OpenAIProvider } = await import("./index.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    new OpenAIProvider({ apiKey: "k", baseURL: "https://api.example.com" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('does not end with "/v1"'));

    warnSpy.mockRestore();
  });
});
