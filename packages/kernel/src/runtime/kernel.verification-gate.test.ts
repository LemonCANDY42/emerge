/**
 * Tests for ADR 0035 — kernel-enforced verification gate before task exit.
 *
 * Covers:
 *   G1: requireVerdictBeforeExit=true + no verdict issued → endSession returns E_NO_VERIFICATION_CALLED
 *   G2: requireVerdictBeforeExit=true + aligned verdict issued → endSession succeeds
 *   G3: requireVerdictBeforeExit unset (undefined) → endSession behaves as today
 *       (back-compat: existing ADR 0012 aligned gate still fires when adjudicator is set)
 *   G4: requireVerdictBeforeExit=true + non-aligned verdict → E_NO_VERIFICATION_CALLED
 *       (gate fires before the aligned-kind check)
 *   G5: requireVerdictBeforeExit=true + trustMode="implicit" → no gate (bypassed)
 */

import { describe, expect, it } from "vitest";
import type {
  AgentId,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  Result,
  SessionId,
  Verdict,
} from "../contracts/index.js";
import type { VerificationConfig } from "./kernel.js";
import { Kernel } from "./kernel.js";

// ---------------------------------------------------------------------------
// Helpers (mirrors agent-runner.verification.test.ts pattern)
// ---------------------------------------------------------------------------

function agentId(s: string): AgentId {
  return s as AgentId;
}
function sessId(s: string): SessionId {
  return s as SessionId;
}

const ADJUDICATOR_ID = agentId("adjudicator-gate-test");

function makeSingleTurnProvider(id = "mock"): Provider {
  const capabilities: ProviderCapabilities = {
    id,
    claimed: {
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      nativeToolUse: true,
      streamingToolUse: false,
      vision: false,
      audio: false,
      thinking: false,
      latencyTier: "interactive",
    },
  };
  const SCRIPT: ReadonlyArray<ProviderEvent> = [
    { type: "text_delta", text: "done" },
    {
      type: "stop",
      reason: "end_turn",
      usage: { tokensIn: 10, tokensOut: 5, wallMs: 10, toolCalls: 0, usd: 0.001 },
    },
  ];
  return {
    capabilities,
    async *invoke(req: ProviderRequest): AsyncGenerator<ProviderEvent> {
      for (const event of SCRIPT) {
        if (req.signal?.aborted) return;
        yield event;
      }
    },
    async countTokens(_messages: readonly ProviderMessage[]): Promise<Result<number>> {
      return { ok: true, value: 10 };
    },
  };
}

function makeSpec(id: AgentId) {
  return {
    id,
    role: "worker",
    description: "gate test agent",
    provider: { kind: "static" as const, providerId: "mock" },
    system: { kind: "literal" as const, text: "You are a test agent." },
    toolsAllowed: [] as string[],
    memoryView: { inheritFromSupervisor: false, writeTags: [] as string[] },
    budget: { tokensIn: 10_000, tokensOut: 2000, usd: 1.0 },
    termination: {
      maxIterations: 1,
      maxWallMs: 10_000,
      budget: { tokensIn: 10_000, tokensOut: 2000 },
      retry: { transient: 0, nonRetryable: 0 as const },
      cycle: { windowSize: 5, repeatThreshold: 3 },
      done: { kind: "predicate" as const, description: "end_turn" },
    },
    acl: {
      acceptsRequests: "any" as const,
      acceptsQueries: "any" as const,
      acceptsSignals: "any" as const,
      acceptsNotifications: "any" as const,
    },
    capabilities: {
      tools: [] as string[],
      modalities: ["text" as const],
      qualityTier: "standard" as const,
      streaming: false,
      interrupts: false,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
    surveillance: "off" as const,
  };
}

/**
 * Make a kernel + run agent; optionally wire a verdict from the adjudicator.
 */
async function runKernelWithVerification(opts: {
  verification: VerificationConfig;
  verdict?: Verdict;
  trustMode?: "implicit" | "explicit";
}): Promise<ReturnType<InstanceType<typeof Kernel>["endSession"]>> {
  const kernel = new Kernel(
    {
      mode: "auto",
      reproducibility: "free",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 256 },
      roles: { adjudicator: ADJUDICATOR_ID },
      ...(opts.trustMode !== undefined ? { trustMode: opts.trustMode } : {}),
    },
    {
      verification: opts.verification,
    },
  );
  kernel.mountProvider(makeSingleTurnProvider());

  const sessionId = sessId(`sess-gate-${Date.now()}-${Math.random()}`);
  kernel.setSession(sessionId, "gate-contract" as never);

  const bus = kernel.getBus();

  // If a verdict is to be sent, wire it as the adjudicator.
  if (opts.verdict) {
    const verdict = opts.verdict;
    const verdictSub = bus.subscribe(ADJUDICATOR_ID, { kind: "self" });
    // Send verdict directly after a short delay (not triggered by request, like
    // the Adjudicator would do in production — we just emit it to the bus).
    void (async () => {
      // Wait for any request to arrive (or just send immediately — the kernel
      // reads all verdicts from the adjudicator regardless of correlation).
      // We send immediately; the kernel's verdict subscription will pick it up.
      await bus.send({
        kind: "verdict",
        correlationId: `gate-corr-${Date.now()}` as never,
        sessionId,
        from: ADJUDICATOR_ID,
        to: { kind: "broadcast" },
        timestamp: Date.now(),
        verdict,
      });
      verdictSub.close();
    })();
  }

  const spawn = await kernel.spawn(makeSpec(agentId(`gate-agent-${Date.now()}`)));
  if (spawn.ok) {
    await kernel.runAgent(spawn.value);
  }

  return kernel.endSession();
}

// ---------------------------------------------------------------------------
// G1: requireVerdictBeforeExit=true + no verdict → E_NO_VERIFICATION_CALLED
// ---------------------------------------------------------------------------

describe("G1: requireVerdictBeforeExit=true, no verdict issued → E_NO_VERIFICATION_CALLED", () => {
  it("endSession returns E_NO_VERIFICATION_CALLED when no verdict was issued", async () => {
    const result = await runKernelWithVerification({
      verification: {
        mode: "per-step",
        timeoutMs: 100,
        requireVerdictBeforeExit: true,
      },
      // No verdict provided
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_NO_VERIFICATION_CALLED");
      expect(result.error.message).toMatch(/never issued a verdict/);
      expect(result.error.message).toMatch(ADJUDICATOR_ID);
    }
  }, 5_000);
});

// ---------------------------------------------------------------------------
// G2: requireVerdictBeforeExit=true + aligned verdict → endSession succeeds
// ---------------------------------------------------------------------------

describe("G2: requireVerdictBeforeExit=true + aligned verdict → endSession succeeds", () => {
  it("endSession returns ok=true when an aligned verdict was issued", async () => {
    const result = await runKernelWithVerification({
      verification: {
        mode: "per-step",
        timeoutMs: 500,
        requireVerdictBeforeExit: true,
      },
      verdict: { kind: "aligned", rationale: "looks good", evidence: [] } satisfies Verdict,
    });

    // Allow a small window for the verdict to be received asynchronously
    // before endSession is called. If the race is tight we re-try once.
    // In practice the verdict fires before runAgent resolves since the agent
    // emits end_turn synchronously in the scripted provider.
    expect(result.ok).toBe(true);
  }, 5_000);
});

// ---------------------------------------------------------------------------
// G3: requireVerdictBeforeExit unset → back-compat (existing ADR 0012 gate)
// ---------------------------------------------------------------------------

describe("G3: requireVerdictBeforeExit unset → back-compat (ADR 0012 gate still active)", () => {
  it("endSession returns E_NO_ALIGNED_VERDICT (not E_NO_VERIFICATION_CALLED) when no verdict and flag is unset", async () => {
    const result = await runKernelWithVerification({
      verification: {
        mode: "per-step",
        timeoutMs: 100,
        // requireVerdictBeforeExit is NOT set
      },
      // No verdict provided
    });

    // The existing ADR 0012 gate fires: E_NO_ALIGNED_VERDICT
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_NO_ALIGNED_VERDICT");
    }
  }, 5_000);

  it("endSession returns E_NO_ALIGNED_VERDICT when requireVerdictBeforeExit=false", async () => {
    const result = await runKernelWithVerification({
      verification: {
        mode: "per-step",
        timeoutMs: 100,
        requireVerdictBeforeExit: false,
      },
      // No verdict
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_NO_ALIGNED_VERDICT");
    }
  }, 5_000);
});

// ---------------------------------------------------------------------------
// G4: requireVerdictBeforeExit=true + non-aligned verdict issued
// ---------------------------------------------------------------------------

describe("G4: requireVerdictBeforeExit=true + off-track verdict → E_NO_ALIGNED_VERDICT after gate passes", () => {
  it("endSession returns E_NO_ALIGNED_VERDICT (not E_NO_VERIFICATION_CALLED) when off-track verdict was issued", async () => {
    // A verdict WAS issued — so E_NO_VERIFICATION_CALLED should NOT fire.
    // But it's not "aligned", so E_NO_ALIGNED_VERDICT should fire.
    const result = await runKernelWithVerification({
      verification: {
        mode: "per-step",
        timeoutMs: 500,
        requireVerdictBeforeExit: true,
      },
      verdict: {
        kind: "off-track",
        reason: "did not complete",
        suggestion: "try again",
      } satisfies Verdict,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The requireVerdictBeforeExit gate should pass (verdict WAS issued),
      // so the error must be from the ADR 0012 aligned gate.
      expect(result.error.code).toBe("E_NO_ALIGNED_VERDICT");
    }
  }, 5_000);
});

// ---------------------------------------------------------------------------
// G5: trustMode="implicit" bypasses both gates
// ---------------------------------------------------------------------------

describe("G5: trustMode=implicit bypasses requireVerdictBeforeExit gate", () => {
  it("endSession succeeds even with requireVerdictBeforeExit=true when trustMode=implicit", async () => {
    const result = await runKernelWithVerification({
      verification: {
        mode: "per-step",
        timeoutMs: 100,
        requireVerdictBeforeExit: true,
      },
      trustMode: "implicit",
      // No verdict
    });

    expect(result.ok).toBe(true);
  }, 5_000);
});
