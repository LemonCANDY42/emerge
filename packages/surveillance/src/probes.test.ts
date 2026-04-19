/**
 * Probe scorer and runProbesAsync unit tests (M4, M5).
 *
 * Covers:
 *  - scoreProbe: string contains check
 *  - scoreProbe: RegExp test
 *  - scoreProbe: callback function
 *  - scoreProbe: no expectedAnswer → pass if response non-empty
 *  - runProbesAsync: AbortSignal honored (M4)
 *  - runProbesAsync: onProbeError callback called instead of silent swallow (M4)
 *  - runProbesAsync: failed-probe error logged not silently swallowed (M4)
 *  - M5: probe patterns are specific enough not to match the goal text verbatim
 */

import type {
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
} from "@lwrf42/emerge-kernel/contracts";
import { describe, expect, it, vi } from "vitest";
import { CalibratedSurveillance, DEFAULT_PROBES, type Probe } from "./index.js";

// ---- Minimal scripted provider ----

function makeProvider(responses: readonly string[], opts: { failOnIndex?: number } = {}): Provider {
  let callIndex = 0;
  return {
    capabilities: {
      id: "test-provider",
      claimed: {
        contextWindow: 200_000,
        maxOutputTokens: 4096,
        nativeToolUse: false,
        streamingToolUse: false,
        vision: false,
        audio: false,
        thinking: false,
        latencyTier: "interactive",
      },
    } satisfies ProviderCapabilities,
    async *invoke(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      const idx = callIndex++;
      if (opts.failOnIndex !== undefined && idx === opts.failOnIndex) {
        throw new Error(`Simulated provider error at index ${idx}`);
      }
      const text = responses[idx % responses.length] ?? "";
      if (req.signal?.aborted) return;
      yield { type: "text_delta", text };
      yield {
        type: "stop",
        reason: "end_turn",
        usage: { tokensIn: 5, tokensOut: 3, wallMs: 10, toolCalls: 0, usd: 0.001 },
      };
    },
    async countTokens() {
      return { ok: true as const, value: 10 };
    },
  };
}

// ---- Access private scoreProbe via workaround ----

// CalibratedSurveillance.scoreProbe is private, so we test it indirectly
// via runProbesAsync with a single probe.

async function scoreOneProbe(probe: Probe, response: string): Promise<boolean> {
  const surveillance = new CalibratedSurveillance({ maxDepth: 4 });
  const provider = makeProvider([response]);
  const result = await surveillance.runProbesAsync(provider, [probe]);
  if (!result.ok) return false;
  const stats = result.value.perDifficulty[probe.difficulty];
  return (stats?.passed ?? 0) === 1;
}

describe("scoreProbe: string check", () => {
  it("passes when response contains the expected string (case-insensitive)", async () => {
    const probe: Probe = {
      id: "test",
      difficulty: "trivial",
      goal: "say hello",
      tools: [],
      expectedAnswer: "hello",
    };
    expect(await scoreOneProbe(probe, "Hello world")).toBe(true);
    expect(await scoreOneProbe(probe, "hi there")).toBe(false);
  });
});

describe("scoreProbe: RegExp check", () => {
  it("passes when response matches the regex", async () => {
    const probe: Probe = {
      id: "test",
      difficulty: "trivial",
      goal: "say 4",
      tools: [],
      expectedAnswer: /^4$/,
    };
    expect(await scoreOneProbe(probe, "4")).toBe(true);
    expect(await scoreOneProbe(probe, "4 is the answer")).toBe(false);
  });

  it("supports case-insensitive regex", async () => {
    const probe: Probe = {
      id: "test",
      difficulty: "trivial",
      goal: "say paris",
      tools: [],
      expectedAnswer: /paris/i,
    };
    expect(await scoreOneProbe(probe, "PARIS")).toBe(true);
  });
});

describe("scoreProbe: callback function", () => {
  it("passes when callback returns true", async () => {
    const probe: Probe = {
      id: "test",
      difficulty: "trivial",
      goal: "say something with 3+ lines",
      tools: [],
      expectedAnswer: (r) => r.split("\n").length >= 3,
    };
    expect(await scoreOneProbe(probe, "line1\nline2\nline3")).toBe(true);
    expect(await scoreOneProbe(probe, "single line")).toBe(false);
  });
});

describe("scoreProbe: no expectedAnswer", () => {
  it("passes when response is non-empty", async () => {
    const probe: Probe = {
      id: "test",
      difficulty: "trivial",
      goal: "say anything",
      tools: [],
    };
    expect(await scoreOneProbe(probe, "something")).toBe(true);
    expect(await scoreOneProbe(probe, "   ")).toBe(false);
  });
});

describe("M4: runProbesAsync AbortSignal honored", () => {
  it("stops running probes after signal is aborted", async () => {
    const surveillance = new CalibratedSurveillance({ maxDepth: 4 });
    const controller = new AbortController();

    let callCount = 0;
    const provider: Provider = {
      capabilities: {
        id: "abort-test",
        claimed: {
          contextWindow: 200_000,
          maxOutputTokens: 4096,
          nativeToolUse: false,
          streamingToolUse: false,
          vision: false,
          audio: false,
          thinking: false,
          latencyTier: "interactive",
        },
      },
      async *invoke(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        callCount++;
        // Abort after first call
        if (callCount === 1) controller.abort();
        if (req.signal?.aborted) return;
        yield { type: "text_delta", text: "hello" };
        yield {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 5, tokensOut: 3, wallMs: 10, toolCalls: 0, usd: 0 },
        };
      },
      async countTokens() {
        return { ok: true as const, value: 10 };
      },
    };

    // Use all 15 default probes — with abort after first call, should not run all 15
    const result = await surveillance.runProbesAsync(provider, DEFAULT_PROBES, {
      signal: controller.signal,
    });

    expect(result.ok).toBe(true);
    // Should have stopped early — far fewer than 15 calls
    expect(callCount).toBeLessThan(15);
  }, 10000);

  it("returns immediately if signal is already aborted before start", async () => {
    const surveillance = new CalibratedSurveillance({ maxDepth: 4 });
    const controller = new AbortController();
    controller.abort(); // pre-aborted

    let callCount = 0;
    const provider = makeProvider(["response"]);
    const origInvoke = provider.invoke.bind(provider);
    provider.invoke = async function* (req: ProviderRequest): AsyncGenerator<ProviderEvent> {
      callCount++;
      yield* origInvoke(req);
    };

    const result = await surveillance.runProbesAsync(provider, DEFAULT_PROBES, {
      signal: controller.signal,
    });

    expect(result.ok).toBe(true);
    // No calls should have been made — signal was already aborted
    expect(callCount).toBe(0);
  });
});

describe("M4: runProbesAsync onProbeError — errors not silently swallowed", () => {
  it("calls onProbeError when a probe throws", async () => {
    const surveillance = new CalibratedSurveillance({ maxDepth: 4 });
    const errors: Array<{ probe: Probe; error: unknown }> = [];

    const failingProvider: Provider = {
      capabilities: {
        id: "fail-provider",
        claimed: {
          contextWindow: 200_000,
          maxOutputTokens: 4096,
          nativeToolUse: false,
          streamingToolUse: false,
          vision: false,
          audio: false,
          thinking: false,
          latencyTier: "interactive",
        },
      },
      async *invoke(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
        throw new Error("network error");
        // biome-ignore lint/correctness/noUnreachable: unreachable code needed for type signature
        yield {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
        };
      },
      async countTokens() {
        return { ok: true as const, value: 10 };
      },
    };

    const singleProbe: Probe[] = [
      {
        id: "failing-probe",
        difficulty: "trivial",
        goal: "anything",
        tools: [],
        expectedAnswer: /yes/,
      },
    ];

    const result = await surveillance.runProbesAsync(failingProvider, singleProbe, {
      onProbeError: (probe, err) => errors.push({ probe, error: err }),
    });

    expect(result.ok).toBe(true);
    // onProbeError should have been called once
    expect(errors.length).toBe(1);
    expect(errors[0]?.probe.id).toBe("failing-probe");
    expect(String(errors[0]?.error)).toContain("network error");
  });

  it("uses console.warn as default when onProbeError is not provided", async () => {
    const surveillance = new CalibratedSurveillance({ maxDepth: 4 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const failingProvider: Provider = {
      capabilities: {
        id: "fail-provider-2",
        claimed: {
          contextWindow: 200_000,
          maxOutputTokens: 4096,
          nativeToolUse: false,
          streamingToolUse: false,
          vision: false,
          audio: false,
          thinking: false,
          latencyTier: "interactive",
        },
      },
      async *invoke(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
        throw new Error("silent error test");
        // biome-ignore lint/correctness/noUnreachable: unreachable code needed for type signature
        yield {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
        };
      },
      async countTokens() {
        return { ok: true as const, value: 10 };
      },
    };

    await surveillance.runProbesAsync(failingProvider, [
      {
        id: "warn-probe",
        difficulty: "trivial",
        goal: "anything",
        tools: [],
      },
    ]);

    // console.warn should have been called (not silently swallowed)
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("M5: probe patterns are specific (not just goal text substrings)", () => {
  it("medium-rebase probe requires 'git rebase -i HEAD~3' not just 'squash' or 'rebase'", async () => {
    const rebProbe = DEFAULT_PROBES.find((p) => p.id === "probe-medium-rebase");
    expect(rebProbe).toBeDefined();
    if (!rebProbe) return;

    // The goal text contains "rebase" and "squash" but NOT "git rebase -i HEAD~3"
    expect(String(rebProbe.expectedAnswer)).toContain("HEAD~3");

    // A vague response mentioning just "squash" should NOT pass
    expect(await scoreOneProbe(rebProbe, "You can squash commits using interactive rebase.")).toBe(
      false,
    );
    // An accurate response with the specific command should pass
    expect(
      await scoreOneProbe(rebProbe, "Run: git rebase -i HEAD~3 to squash the last 3 commits."),
    ).toBe(true);
  });

  it("medium-regex probe requires '@.*\\.' not just '@'", async () => {
    const regexProbe = DEFAULT_PROBES.find((p) => p.id === "probe-medium-regex");
    expect(regexProbe).toBeDefined();
    if (!regexProbe) return;

    // A pattern with just @ but no dot after it should fail
    expect(await scoreOneProbe(regexProbe, "^[^@]+$")).toBe(false);
    // A valid email regex pattern with @ and . should pass
    expect(await scoreOneProbe(regexProbe, "[a-z]+@[a-z]+.com")).toBe(true);
  });

  it("research-consensus probe requires a real algorithm name (e.g. raft, paxos)", async () => {
    const consensusProbe = DEFAULT_PROBES.find((p) => p.id === "probe-research-consensus");
    expect(consensusProbe).toBeDefined();
    if (!consensusProbe) return;

    // A generic response without naming any algorithm should fail
    expect(
      await scoreOneProbe(
        consensusProbe,
        "There are three main approaches to consensus: voting, leader election, and broadcast.",
      ),
    ).toBe(false);
    // A response naming Raft should pass
    expect(
      await scoreOneProbe(
        consensusProbe,
        "The three approaches are Raft, Paxos, and PBFT. I recommend Raft for its simplicity.",
      ),
    ).toBe(true);
  });

  it("research-cap probe requires a real database name (e.g. cassandra, redis)", async () => {
    const capProbe = DEFAULT_PROBES.find((p) => p.id === "probe-research-cap");
    expect(capProbe).toBeDefined();
    if (!capProbe) return;

    // A generic response without naming any database should fail
    expect(
      await scoreOneProbe(
        capProbe,
        "The CAP theorem says you can only have two of: consistency, availability, partition tolerance.",
      ),
    ).toBe(false);
    // A response naming Cassandra should pass
    expect(
      await scoreOneProbe(
        capProbe,
        "The CAP theorem: Cassandra (AP), ZooKeeper (CP), MySQL (CA). Each trades off one property.",
      ),
    ).toBe(true);
  });
});
