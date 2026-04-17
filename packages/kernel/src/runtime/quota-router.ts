/**
 * QuotaRouter — routes quota.request envelopes to the Custodian agent; awaits decision.
 *
 * The router does NOT mutate budgets; that's the AgentRunner's responsibility.
 */

import type {
  AgentId,
  Bus,
  CorrelationId,
  QuotaDecision,
  QuotaRequest,
  Result,
  SessionId,
} from "../contracts/index.js";

export class QuotaRouter {
  private readonly bus: Bus;
  private readonly custodianId: AgentId;

  constructor(bus: Bus, custodianId: AgentId) {
    this.bus = bus;
    this.custodianId = custodianId;
  }

  async request(
    sessionId: SessionId,
    fromAgent: AgentId,
    req: QuotaRequest,
  ): Promise<Result<QuotaDecision>> {
    const correlationId = req.correlationId;

    // Subscribe to quota decision envelopes before sending
    const sub = this.bus.subscribe(fromAgent, { kind: "self" });

    const decisionPromise = new Promise<Result<QuotaDecision>>((resolve) => {
      void (async () => {
        for await (const env of sub.events) {
          if (env.correlationId !== correlationId) continue;
          if (
            env.kind === "quota.grant" ||
            env.kind === "quota.deny" ||
            env.kind === "quota.partial"
          ) {
            sub.close();
            resolve({ ok: true, value: env.decision });
            return;
          }
        }
        resolve({
          ok: false,
          error: { code: "E_QUOTA_NO_DECISION", message: "no decision received" },
        });
      })();
    });

    await this.bus.send({
      kind: "quota.request",
      correlationId,
      sessionId,
      from: fromAgent,
      to: { kind: "agent", id: this.custodianId },
      timestamp: Date.now(),
      request: req,
    });

    return decisionPromise;
  }

  /** Convenience: generate a fresh correlationId for a quota request. */
  static makeCorrelationId(): CorrelationId {
    return `quota-${Date.now()}-${Math.random().toString(36).slice(2)}` as CorrelationId;
  }
}
