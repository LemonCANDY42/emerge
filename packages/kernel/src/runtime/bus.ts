/**
 * InMemoryBus — keyed pub/sub with bounded buffers and drop-oldest back-pressure.
 *
 * C2: Enforces AgentCard.acl on send() for agent-addressed envelopes.
 *     CardRegistry is populated by Kernel.spawn() / unregister on terminate.
 *     Blocked sends return E_ACL_BLOCKED; a per-bus drop counter is exposed
 *     via getDropStats() (for M4 observability).
 */

import type {
  AcceptScope,
  AgentCard,
  AgentId,
  Bus,
  BusBackpressureConfig,
  BusEnvelope,
  CorrelationId,
  KernelConfig,
  RequestEnvelope,
  Result,
  ResultEnvelope,
  SignalEnvelope,
  Subscription,
  SubscriptionTarget,
} from "../contracts/index.js";

interface BufferedSubscription {
  subscriber: AgentId;
  target: SubscriptionTarget;
  buffer: BusEnvelope[];
  maxSize: number;
  // resolve waiting reader
  resolve: ((env: BusEnvelope) => void) | null;
  closed: boolean;
  /** M4: count of envelopes dropped due to buffer overflow. */
  droppedCount: number;
}

/** Roles config is optional — used only for custodian-and-adjudicator-only ACL checks. */
type RolesConfig = KernelConfig["roles"];

function checkAclScope(
  scope: AcceptScope,
  from: AgentId,
  receiverCard: AgentCard,
  roles: RolesConfig,
): boolean {
  if (scope === "any") return true;
  if (scope === "supervisor-only") {
    return receiverCard.lineage.spawnedBy === from;
  }
  if (scope === "topology-peers") {
    // M1 limitation: topology peer sets are not tracked in M1.
    // Treat as "any" and log the limitation.
    // TODO(M2): wire topology helper to register peer sets per agent.
    return true;
  }
  if (scope === "custodian-and-adjudicator-only") {
    return from === roles.custodian || from === roles.adjudicator;
  }
  // { allow: readonly AgentId[] }
  return scope.allow.includes(from);
}

/**
 * Map an envelope kind to the AgentCard.acl field that gates it.
 * request/query → acceptsRequests
 * signal        → acceptsSignals
 * anything else → acceptsNotifications
 */
function aclScopeForKind(kind: BusEnvelope["kind"], card: AgentCard): AcceptScope {
  switch (kind) {
    case "request":
    case "query":
      return card.acl.acceptsRequests;
    case "signal":
      return card.acl.acceptsSignals;
    default:
      return card.acl.acceptsNotifications;
  }
}

export interface BusDropStats {
  readonly aclBlocked: number;
  /** M4: per-subscriber drop counts due to buffer overflow. */
  readonly perSubscriber: ReadonlyMap<AgentId, number>;
}

export class InMemoryBus implements Bus {
  private readonly subs: Set<BufferedSubscription> = new Set();
  private readonly config: BusBackpressureConfig;
  /** C2: registered agent cards for ACL enforcement. */
  private readonly cardRegistry = new Map<AgentId, AgentCard>();
  private readonly roles: RolesConfig;
  private aclBlocked = 0;
  private readonly perSubscriberDrops = new Map<AgentId, number>();

  constructor(config: BusBackpressureConfig = { bufferSize: 256 }, roles: RolesConfig = {}) {
    this.config = config;
    this.roles = roles;
  }

  /** C2: Register an agent card so send() can enforce its ACL. */
  registerCard(card: AgentCard): void {
    this.cardRegistry.set(card.id, card);
  }

  /** C2: Unregister on terminate. */
  unregisterCard(id: AgentId): void {
    this.cardRegistry.delete(id);
  }

  /** M4: Exposed for observability — includes per-subscriber overflow drop counts. */
  getDropStats(): BusDropStats {
    return {
      aclBlocked: this.aclBlocked,
      perSubscriber: new Map(this.perSubscriberDrops),
    };
  }

  async send(env: BusEnvelope): Promise<Result<void>> {
    // C2: ACL check for agent-addressed envelopes only.
    // Broadcast/topic messages skip per-agent ACL (no single receiver).
    if (env.to.kind === "agent") {
      const receiverCard = this.cardRegistry.get(env.to.id);
      if (receiverCard) {
        const scope = aclScopeForKind(env.kind, receiverCard);
        const allowed = checkAclScope(scope, env.from, receiverCard, this.roles);
        if (!allowed) {
          this.aclBlocked++;
          return {
            ok: false,
            error: {
              code: "E_ACL_BLOCKED",
              message: `agent ${String(env.from)} is not permitted to send '${env.kind}' to ${String(env.to.id)} (ACL: ${JSON.stringify(scope)})`,
              retriable: false,
            },
          };
        }
      }
    }

    this.fanOut(env);
    return { ok: true, value: undefined };
  }

  subscribe(subscriber: AgentId, target: SubscriptionTarget): Subscription {
    const maxSize =
      "kinds" in target && target.kinds ? this.config.bufferSize : this.config.bufferSize;

    const sub: BufferedSubscription = {
      subscriber,
      target,
      buffer: [],
      maxSize,
      resolve: null,
      closed: false,
      droppedCount: 0,
    };

    this.subs.add(sub);

    const events = this.makeAsyncIterable(sub);

    const subscription: Subscription & { readonly droppedCount: number } = {
      events,
      get droppedCount(): number {
        return sub.droppedCount;
      },
      close: () => {
        sub.closed = true;
        if (sub.resolve) {
          // unblock waiting reader so the generator can see closed=true
          const res = sub.resolve;
          sub.resolve = null;
          // inject a sentinel — the generator checks sub.closed and terminates
          const sentinel: SignalEnvelope = {
            kind: "signal",
            correlationId: "" as CorrelationId,
            sessionId: "" as never,
            from: subscriber,
            to: { kind: "broadcast" },
            timestamp: Date.now(),
            signal: "terminate",
          };
          res(sentinel);
        }
        this.subs.delete(sub);
      },
    };
    return subscription;
  }

  async request(env: RequestEnvelope): Promise<Result<ResultEnvelope>> {
    const sub = this.subscribe(env.from, {
      kind: "from",
      sender: env.to.kind === "agent" ? env.to.id : env.from,
    });

    const promise = new Promise<Result<ResultEnvelope>>((settle) => {
      void (async () => {
        for await (const received of sub.events) {
          if (received.correlationId !== env.correlationId) continue;
          if (received.kind === "result") {
            sub.close();
            settle({ ok: true, value: received });
            return;
          }
          if (
            received.kind === "signal" &&
            (received.signal === "terminate" || received.signal === "interrupt")
          ) {
            sub.close();
            settle({
              ok: false,
              error: { code: "E_SIGNAL", message: `signal:${received.signal}` },
            });
            return;
          }
        }
        settle({
          ok: false,
          error: { code: "E_CLOSED", message: "subscription closed without result" },
        });
      })();
    });

    await this.send(env);
    return promise;
  }

  stream(env: RequestEnvelope): Subscription {
    const sub = this.subscribe(env.from, {
      kind: "from",
      sender: env.to.kind === "agent" ? env.to.id : env.from,
    });

    // send async so caller can attach first
    void this.send(env);
    return sub;
  }

  async interrupt(target: AgentId, reason?: string): Promise<Result<void>> {
    const base: Omit<SignalEnvelope, "reason"> = {
      kind: "signal",
      correlationId: `int-${Date.now()}` as CorrelationId,
      sessionId: "" as never,
      from: "kernel" as AgentId,
      to: { kind: "agent", id: target },
      timestamp: Date.now(),
      signal: "interrupt",
    };
    const signal: SignalEnvelope = reason !== undefined ? { ...base, reason } : base;
    return this.send(signal);
  }

  // --- internal ---

  private fanOut(env: BusEnvelope): void {
    for (const sub of this.subs) {
      if (sub.closed) continue;
      if (!this.matches(sub, env)) continue;

      if (sub.buffer.length >= sub.maxSize) {
        // M4: drop oldest and record the drop
        sub.buffer.shift();
        sub.droppedCount++;
        this.perSubscriberDrops.set(
          sub.subscriber,
          (this.perSubscriberDrops.get(sub.subscriber) ?? 0) + 1,
        );
      }
      sub.buffer.push(env);

      if (sub.resolve) {
        const res = sub.resolve;
        sub.resolve = null;
        const next = sub.buffer.shift();
        if (next !== undefined) res(next);
      }
    }
  }

  private matches(sub: BufferedSubscription, env: BusEnvelope): boolean {
    const { target, subscriber } = sub;
    if (target.kind === "self") {
      // deliver everything addressed to this subscriber
      return env.to.kind === "agent" && env.to.id === subscriber;
    }
    if (target.kind === "from") {
      // M5: drop the `toMatch` clause so subscribers observe a sender's
      // broadcasts to OTHER agents too (not just messages addressed to them).
      const fromMatch = env.from === target.sender;
      const kindMatch = !target.kinds || target.kinds.includes(env.kind);
      return fromMatch && kindMatch;
    }
    if (target.kind === "topic") {
      const topicMatch =
        env.kind === "notification" && (env as { topic?: string }).topic === target.topic;
      const kindMatch = !target.kinds || target.kinds.includes(env.kind);
      return topicMatch && kindMatch;
    }
    return false;
  }

  private makeAsyncIterable(sub: BufferedSubscription): AsyncIterable<BusEnvelope> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<BusEnvelope>> {
            if (sub.closed && sub.buffer.length === 0) {
              return Promise.resolve({ done: true, value: undefined as never });
            }
            if (sub.buffer.length > 0) {
              const next = sub.buffer.shift();
              return Promise.resolve({ done: false, value: next as BusEnvelope });
            }
            return new Promise<IteratorResult<BusEnvelope>>((resolve) => {
              sub.resolve = (env) => {
                if (sub.closed && sub.buffer.length === 0) {
                  resolve({ done: true, value: undefined as never });
                } else {
                  resolve({ done: false, value: env });
                }
              };
            });
          },
          return(): Promise<IteratorResult<BusEnvelope>> {
            sub.closed = true;
            return Promise.resolve({ done: true, value: undefined as never });
          },
        };
      },
    };
  }
}
