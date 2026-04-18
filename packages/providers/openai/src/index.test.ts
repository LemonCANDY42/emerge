/**
 * OpenAIProvider tests.
 *
 * M5: Verifies that response.error and error event types from the Responses API
 * stream are yielded as ProviderEvent { type: "error" } rather than silently swallowed.
 *
 * C4: Verifies that costPerMtokIn/Out constructor overrides are reflected in capabilities.
 */

import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "./index.js";

describe("C4: OpenAIProvider cost override", () => {
  it("includes costPerMtokIn/Out in claimed capabilities when provided", () => {
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4o",
      costPerMtokIn: 3.0,
      costPerMtokOut: 9.0,
    });

    expect(provider.capabilities.claimed.costPerMtokIn).toBe(3.0);
    expect(provider.capabilities.claimed.costPerMtokOut).toBe(9.0);
  });

  it("uses default capabilities when no cost override provided", () => {
    const provider = new OpenAIProvider({ apiKey: "test-key", model: "gpt-4o" });
    // Default GPT-4o costs (from DEFAULT_CLAIMED_CAPABILITIES)
    expect(provider.capabilities.claimed.costPerMtokIn).toBe(5);
    expect(provider.capabilities.claimed.costPerMtokOut).toBe(15);
  });

  it("custom baseURL uses conservative defaults (no costPerMtok)", () => {
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "custom-model",
      baseURL: "http://localhost:11434/v1",
    });
    // Conservative custom URL capabilities have no cost fields
    expect(provider.capabilities.claimed.costPerMtokIn).toBeUndefined();
    expect(provider.capabilities.claimed.costPerMtokOut).toBeUndefined();
  });

  it("costPerMtokIn/Out override wins even for custom baseURL", () => {
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "custom-model",
      baseURL: "http://localhost:11434/v1",
      costPerMtokIn: 0.25,
      costPerMtokOut: 0.75,
    });
    expect(provider.capabilities.claimed.costPerMtokIn).toBe(0.25);
    expect(provider.capabilities.claimed.costPerMtokOut).toBe(0.75);
  });
});

describe("M5: OpenAI Responses API — error event handling", () => {
  /**
   * We test the responses-protocol error path by constructing a provider with
   * a mocked underlying OpenAI client (patched after construction) that yields
   * synthetic error events from the stream.
   */
  it("emits ProviderEvent error for response.error stream events", async () => {
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
      protocol: "responses",
    });

    // Patch the internal client to provide a fake responses API
    const fakeStream = async function* () {
      yield { type: "response.error", error: { message: "rate limit exceeded", code: "429" } };
    };

    const fakeResponses = {
      create: async (_params: unknown) => fakeStream(),
    };

    // Access the private client via cast — this is a white-box test
    (provider as unknown as { client: { responses?: unknown } }).client.responses = fakeResponses;

    const events: import("@emerge/kernel/contracts").ProviderEvent[] = [];
    for await (const event of provider.invoke({
      messages: [{ role: "system", content: "test" }],
    })) {
      events.push(event);
    }

    // Should have emitted an error event and returned
    expect(events.some((e) => e.type === "error")).toBe(true);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === "error") {
      expect(errorEvent.error.message).toContain("rate limit exceeded");
    }
  });

  it("emits ProviderEvent error for bare error event type", async () => {
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
      protocol: "responses",
    });

    const fakeStream = async function* () {
      yield { type: "error", message: "server error", code: "500" };
    };

    const fakeResponses = {
      create: async (_params: unknown) => fakeStream(),
    };

    (provider as unknown as { client: { responses?: unknown } }).client.responses = fakeResponses;

    const events: import("@emerge/kernel/contracts").ProviderEvent[] = [];
    for await (const event of provider.invoke({
      messages: [{ role: "system", content: "test" }],
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("does not hang or swallow errors — returns after error event", async () => {
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
      protocol: "responses",
    });

    let streamCompleted = false;
    const fakeStream = async function* () {
      yield { type: "response.error", error: { message: "upstream failure" } };
      // This should NOT be reached because the error path returns early
      streamCompleted = true;
    };

    const fakeResponses = {
      create: async (_params: unknown) => fakeStream(),
    };

    (provider as unknown as { client: { responses?: unknown } }).client.responses = fakeResponses;

    const events: import("@emerge/kernel/contracts").ProviderEvent[] = [];
    for await (const event of provider.invoke({
      messages: [{ role: "system", content: "test" }],
    })) {
      events.push(event);
    }

    // Should have exactly one event (the error), then return
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    // streamCompleted is false because return was called before yielding again
    expect(streamCompleted).toBe(false);
  });
});
