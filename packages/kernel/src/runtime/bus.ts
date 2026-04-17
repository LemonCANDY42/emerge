/**
 * InMemoryBus — keyed pub/sub with bounded buffers and drop-oldest back-pressure.
 */

import type {
  AgentId,
  Bus,
  BusBackpressureConfig,
  BusEnvelope,
  CorrelationId,
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
}

export class InMemoryBus implements Bus {
  private readonly subs: Set<BufferedSubscription> = new Set();
  private readonly config: BusBackpressureConfig;

  constructor(config: BusBackpressureConfig = { bufferSize: 256 }) {
    this.config = config;
  }

  async send(env: BusEnvelope): Promise<Result<void>> {
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
    };

    this.subs.add(sub);

    const events = this.makeAsyncIterable(sub);

    return {
      events,
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
        // drop oldest
        sub.buffer.shift();
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
      const fromMatch = env.from === target.sender;
      const kindMatch = !target.kinds || target.kinds.includes(env.kind);
      // also deliver to the subscriber if the envelope is addressed to them
      const toMatch = env.to.kind === "agent" && env.to.id === subscriber;
      return fromMatch && kindMatch && toMatch;
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
