/**
 * buildAdjudicator — constructs an in-process Adjudicator instance + its AgentSpec.
 *
 * The Adjudicator:
 *   - Reads the Contract from the Custodian
 *   - Subscribes to result envelopes on the bus (via a topic or all broadcasts)
 *   - Runs the evaluate callback (sync or async) and emits verdict envelopes
 *   - The kernel marks a session completed only after an "aligned" verdict
 *     unless trustMode is "implicit"
 *
 * M3a: The evaluate callback is a plain JS function. LLM-driven evaluation
 * is a follow-up.
 */

import type {
  Adjudicator,
  AgentId,
  AgentSpec,
  Budget,
  Contract,
  CorrelationId,
  EvaluationInput,
  Result,
  SessionId,
  Verdict,
} from "@emerge/kernel/contracts";

export interface BuildAdjudicatorOptions {
  readonly id: AgentId;
  readonly contract: Contract;
  readonly evaluate: (input: EvaluationInput) => Verdict | Promise<Verdict>;
  /**
   * M2: The agent ids whose result envelopes the Adjudicator should evaluate.
   * One subscription is created per sender so broadcasts from any of them are caught.
   * If not provided, watchBus() uses a self-subscription (only catches direct messages).
   */
  readonly resultSenders?: readonly AgentId[];
  /**
   * Provider id to assign to the adjudicator's spec. The adjudicator never makes
   * real LLM calls in M3a, but the kernel requires a mounted provider at spawn time.
   * Pass the id of any mock/stub provider that is mounted on the kernel.
   */
  readonly providerId?: string;
}

export interface AdjudicatorBuild {
  readonly spec: AgentSpec;
  readonly instance: Adjudicator;
  /**
   * Evaluate a given input immediately and return the verdict.
   * Also records the verdict internally for inspection.
   */
  evaluate(input: EvaluationInput): Promise<Verdict>;
  /**
   * Subscribe to result envelopes on the bus and auto-emit verdicts.
   * Call this AFTER bus is live. Returns a cleanup function.
   */
  watchBus(opts: {
    bus: import("@emerge/kernel/contracts").Bus;
    sessionId: SessionId;
  }): () => void;
}

class InProcessAdjudicator implements Adjudicator {
  private readonly _contract: Contract;
  private readonly _evaluate: (input: EvaluationInput) => Verdict | Promise<Verdict>;
  readonly verdicts: Verdict[] = [];

  constructor(
    contract: Contract,
    evaluate: (input: EvaluationInput) => Verdict | Promise<Verdict>,
  ) {
    this._contract = contract;
    this._evaluate = evaluate;
  }

  contract(): Contract {
    return this._contract;
  }

  async evaluate(input: EvaluationInput): Promise<Verdict> {
    const verdict = await this._evaluate(input);
    this.verdicts.push(verdict);
    return verdict;
  }
}

export function buildAdjudicator(opts: BuildAdjudicatorOptions): AdjudicatorBuild {
  const adjInstance = new InProcessAdjudicator(opts.contract, opts.evaluate);

  const budget: Budget = { tokensIn: 1_000, tokensOut: 500, wallMs: 30_000, usd: 0.1 };

  const spec: AgentSpec = {
    id: opts.id,
    role: "adjudicator",
    description: `Compliance adjudicator for contract ${opts.contract.id}`,
    provider: opts.providerId
      ? { kind: "static", providerId: opts.providerId }
      : { kind: "router", preference: [] },
    system: {
      kind: "literal",
      text: `You are the Compliance Adjudicator. You evaluate outputs against the contract and emit verdicts. Contract: ${JSON.stringify(opts.contract)}`,
    },
    toolsAllowed: [],
    memoryView: {
      inheritFromSupervisor: false,
      writeTags: ["adjudicator"],
    },
    budget,
    termination: {
      maxIterations: 1,
      maxWallMs: 30_000,
      budget,
      retry: { transient: 0, nonRetryable: 0 },
      cycle: { windowSize: 3, repeatThreshold: 3 },
      done: { kind: "predicate", description: "Adjudicator does not iterate" },
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

  async function evaluate(input: EvaluationInput): Promise<Verdict> {
    return adjInstance.evaluate(input);
  }

  function watchBus(opts2: {
    bus: import("@emerge/kernel/contracts").Bus;
    sessionId: SessionId;
  }): () => void {
    const { bus, sessionId } = opts2;
    let active = true;

    /**
     * M2: Subscribe to result envelopes from each known sender individually
     * instead of a dead `{kind:"from", sender:"kernel"}` subscription.
     * If no resultSenders were configured, fall back to a self-subscription.
     */
    const senders = opts.resultSenders ?? [];
    const subs =
      senders.length > 0
        ? senders.map((sender) =>
            bus.subscribe(opts.id, {
              kind: "from",
              sender,
              kinds: ["result"],
            }),
          )
        : [bus.subscribe(opts.id, { kind: "self" })];

    // Wire up one async loop per subscription so we don't miss concurrent results.
    for (const sub of subs) {
      void (async () => {
        for await (const env of sub.events) {
          if (!active) break;
          if (env.kind !== "result") continue;

          const evalInput: EvaluationInput = {
            outputs: {
              payload: env.payload,
              from: env.from,
            },
            artifacts: [],
          };

          const verdict = await adjInstance.evaluate(evalInput);

          const corrId = `verdict-${Date.now()}` as CorrelationId;
          await bus.send({
            kind: "verdict",
            correlationId: corrId,
            sessionId,
            from: opts.id,
            to: { kind: "broadcast" },
            timestamp: Date.now(),
            verdict,
          });
        }
      })();
    }

    return () => {
      active = false;
      for (const sub of subs) {
        sub.close();
      }
    };
  }

  return {
    spec,
    instance: adjInstance,
    evaluate,
    watchBus,
  };
}
