/**
 * makeVerifierAgent — constructs an in-process verifier that participates in the
 * M3b per-step verification protocol (ADR 0032).
 *
 * The verifier subscribes to `request` envelopes containing a `verdict_request`
 * payload, calls the caller-supplied `evaluate` function, and replies with a
 * `verdict` envelope. The agent spec can then be spawned on the kernel so the
 * agent runner can route verification requests to it by id.
 *
 * Usage:
 *   const { spec, watchBus } = makeVerifierAgent({ id: "my-verifier", evaluate });
 *   // Optionally spawn spec on the kernel, or just call watchBus() to handle
 *   // verification requests in-process without a full provider round-trip.
 *   const cleanup = watchBus({ bus: kernel.getBus(), sessionId });
 *   // ... run agents ...
 *   cleanup();
 *
 * See ADR 0032.
 */

import type {
  AgentId,
  AgentSpec,
  Budget,
  Contract,
  CorrelationId,
  Result,
  SessionId,
  Verdict,
} from "@lwrf42/emerge-kernel/contracts";

/**
 * Payload expected inside the `request` envelope sent by the agent runner.
 * Defined here so verifier implementations don't need to read agent-runner source.
 */
export interface VerdictRequestPayload {
  readonly type: "verdict_request";
  readonly stepId: string;
  readonly output: string;
}

export interface MakeVerifierAgentOptions {
  /**
   * AgentId that the kernel will route verdict_request envelopes to.
   * Must match the `verifier` field in VerificationConfig.
   */
  readonly id: AgentId;
  /**
   * The contract this verifier evaluates against. Used to build the AgentSpec
   * description. If you don't have a contract, pass a minimal stub.
   */
  readonly contract?: Contract;
  /**
   * Evaluate a verdict_request payload and return the appropriate Verdict.
   * Called once per incoming request envelope. May be async.
   */
  readonly evaluate: (payload: VerdictRequestPayload) => Verdict | Promise<Verdict>;
  /**
   * Provider id for the spec (the verifier never makes real LLM calls in-process,
   * but the kernel requires a mounted provider at spawn time).
   */
  readonly providerId?: string;
}

export interface VerifierAgentBuild {
  /** AgentSpec to pass to kernel.spawn() if you want the agent formally registered. */
  readonly spec: AgentSpec;
  /**
   * Subscribe to verdict_request envelopes on the bus and emit verdict replies.
   * Call this AFTER the bus is live. Returns a cleanup function.
   */
  watchBus(opts: {
    bus: import("@lwrf42/emerge-kernel/contracts").Bus;
    sessionId: SessionId;
  }): () => void;
  /**
   * Directly evaluate a payload — useful for testing or non-bus paths.
   */
  evaluate(payload: VerdictRequestPayload): Promise<Verdict>;
}

export function makeVerifierAgent(opts: MakeVerifierAgentOptions): VerifierAgentBuild {
  const budget: Budget = { tokensIn: 1_000, tokensOut: 500, wallMs: 30_000, usd: 0.1 };

  const spec: AgentSpec = {
    id: opts.id,
    role: "adjudicator",
    description: opts.contract
      ? `Post-step verifier for contract ${opts.contract.id}`
      : "Post-step verifier (ADR 0032)",
    provider: opts.providerId
      ? { kind: "static", providerId: opts.providerId }
      : { kind: "router", preference: [] },
    system: {
      kind: "literal",
      text: "You are a post-step verifier. You evaluate agent outputs and emit verdicts: aligned, off-track, failed, or partial.",
    },
    toolsAllowed: [],
    memoryView: {
      inheritFromSupervisor: false,
      writeTags: ["verifier"],
    },
    budget,
    termination: {
      maxIterations: 1,
      maxWallMs: 30_000,
      budget,
      retry: { transient: 0, nonRetryable: 0 },
      cycle: { windowSize: 3, repeatThreshold: 3 },
      done: { kind: "predicate", description: "Verifier does not iterate" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: [],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: false,
      interrupts: false,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
  };

  async function evaluate(payload: VerdictRequestPayload): Promise<Verdict> {
    return opts.evaluate(payload);
  }

  function watchBus(opts2: {
    bus: import("@lwrf42/emerge-kernel/contracts").Bus;
    sessionId: SessionId;
  }): () => void {
    const { bus, sessionId } = opts2;
    let active = true;

    // Subscribe to all `request` envelopes addressed to this verifier id.
    const sub = bus.subscribe(opts.id, { kind: "self" });

    void (async () => {
      for await (const env of sub.events) {
        if (!active) break;
        if (env.kind !== "request") continue;

        // Only handle verdict_request payloads (other request kinds are ignored)
        const payload = env.payload as Partial<VerdictRequestPayload>;
        if (payload?.type !== "verdict_request") continue;

        let verdict: Verdict;
        try {
          verdict = await opts.evaluate(payload as VerdictRequestPayload);
        } catch (err) {
          // On evaluation error, emit a "failed" verdict so the runner is not left waiting
          verdict = {
            kind: "failed",
            reason: `Verifier threw an error: ${String(err)}`,
          };
        }

        const corrId = `verdict-reply-${Date.now()}` as CorrelationId;
        await bus.send({
          kind: "verdict",
          correlationId: env.correlationId,
          sessionId,
          from: opts.id,
          to: { kind: "broadcast" },
          timestamp: Date.now(),
          verdict,
        });
        void corrId; // corrId is used in the send above for type safety; suppress unused warning
      }
    })();

    return () => {
      active = false;
      sub.close();
    };
  }

  return { spec, watchBus, evaluate };
}

export type { Result };
