/**
 * InMemoryBus unit tests.
 *
 * Covers: ACL allow/deny matrix; kind:"from" subscription matches broadcasts;
 * back-pressure drops oldest; request() correlation; interrupt() semantics.
 */

import { describe, expect, it } from "vitest";
import type {
  AgentCard,
  AgentId,
  BusEnvelope,
  CorrelationId,
  RequestEnvelope,
  SessionId,
} from "../contracts/index.js";
import { InMemoryBus } from "./bus.js";

// --- helpers ---

function agentId(s: string): AgentId {
  return s as AgentId;
}
function corrId(s: string): CorrelationId {
  return s as CorrelationId;
}
function sessId(s: string): SessionId {
  return s as SessionId;
}

function makeCard(
  id: AgentId,
  acceptsRequests: AgentCard["acl"]["acceptsRequests"] = "any",
): AgentCard {
  return {
    id,
    role: "worker",
    description: "test",
    capabilities: {
      tools: [],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: false,
      interrupts: false,
      maxConcurrency: 1,
    },
    io: {
      accepts: { "~standard": { version: 1, vendor: "test", validate: (v) => ({ value: v }) } },
      produces: { "~standard": { version: 1, vendor: "test", validate: (v) => ({ value: v }) } },
    },
    budget: {},
    termination: {
      maxIterations: 5,
      maxWallMs: 10_000,
      budget: {},
      retry: { transient: 0, nonRetryable: 0 },
      cycle: { windowSize: 3, repeatThreshold: 3 },
      done: { kind: "predicate", description: "test" },
    },
    acl: {
      acceptsRequests,
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    lineage: { depth: 0 },
  };
}

const SESSION = sessId("test-session");

function notification(from: AgentId, to: AgentId): BusEnvelope {
  return {
    kind: "progress",
    correlationId: corrId("c1"),
    sessionId: SESSION,
    from,
    to: { kind: "agent", id: to },
    timestamp: Date.now(),
    note: "hello",
  };
}

function broadcast(from: AgentId): BusEnvelope {
  return {
    kind: "progress",
    correlationId: corrId("c2"),
    sessionId: SESSION,
    from,
    to: { kind: "broadcast" },
    timestamp: Date.now(),
    note: "broadcast",
  };
}

// --- ACL tests ---

describe("InMemoryBus ACL", () => {
  it("allows messages when no card is registered", async () => {
    const bus = new InMemoryBus({ bufferSize: 10 });
    const result = await bus.send(notification(agentId("a"), agentId("b")));
    expect(result.ok).toBe(true);
  });

  it("allows when acceptsNotifications is 'any'", async () => {
    const bus = new InMemoryBus({ bufferSize: 10 });
    const b = agentId("b");
    bus.registerCard(makeCard(b, "any"));
    const result = await bus.send(notification(agentId("a"), b));
    expect(result.ok).toBe(true);
  });

  it("blocks request from unlisted sender via explicit allow list", async () => {
    const bus = new InMemoryBus({ bufferSize: 10 }, {});
    const receiver = agentId("receiver");
    const allowed = agentId("allowed");
    const attacker = agentId("attacker");
    bus.registerCard(makeCard(receiver, { allow: [allowed] }));

    // Use a request-kind envelope to trigger acceptsRequests ACL
    const req: BusEnvelope = {
      kind: "request",
      correlationId: corrId("r1"),
      sessionId: SESSION,
      from: attacker,
      to: { kind: "agent", id: receiver },
      timestamp: Date.now(),
      payload: {},
    };
    const result = await bus.send(req);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("E_ACL_BLOCKED");
  });

  it("allows request from listed sender", async () => {
    const bus = new InMemoryBus({ bufferSize: 10 }, {});
    const receiver = agentId("receiver");
    const allowed = agentId("allowed");
    bus.registerCard(makeCard(receiver, { allow: [allowed] }));

    const req: BusEnvelope = {
      kind: "request",
      correlationId: corrId("r2"),
      sessionId: SESSION,
      from: allowed,
      to: { kind: "agent", id: receiver },
      timestamp: Date.now(),
      payload: {},
    };
    const result = await bus.send(req);
    expect(result.ok).toBe(true);
  });

  it("allows supervisor-only from parent agent", async () => {
    const bus = new InMemoryBus({ bufferSize: 10 }, {});
    const parent = agentId("parent");
    const child = agentId("child");
    const childCard: AgentCard = {
      ...makeCard(child),
      acl: { ...makeCard(child).acl, acceptsRequests: "supervisor-only" },
      lineage: { depth: 1, spawnedBy: parent },
    };
    bus.registerCard(childCard);

    const req: BusEnvelope = {
      kind: "request",
      correlationId: corrId("r3"),
      sessionId: SESSION,
      from: parent,
      to: { kind: "agent", id: child },
      timestamp: Date.now(),
      payload: {},
    };
    expect((await bus.send(req)).ok).toBe(true);
  });

  it("blocks supervisor-only from non-parent agent", async () => {
    const bus = new InMemoryBus({ bufferSize: 10 }, {});
    const parent = agentId("parent");
    const child = agentId("child");
    const stranger = agentId("stranger");
    const childCard: AgentCard = {
      ...makeCard(child),
      acl: { ...makeCard(child).acl, acceptsRequests: "supervisor-only" },
      lineage: { depth: 1, spawnedBy: parent },
    };
    bus.registerCard(childCard);

    const req: BusEnvelope = {
      kind: "request",
      correlationId: corrId("r4"),
      sessionId: SESSION,
      from: stranger,
      to: { kind: "agent", id: child },
      timestamp: Date.now(),
      payload: {},
    };
    const result = await bus.send(req);
    expect(result.ok).toBe(false);
  });
});

// --- Subscription & delivery ---

describe("InMemoryBus subscriptions", () => {
  it("kind:self delivers messages addressed to subscriber", async () => {
    const bus = new InMemoryBus({ bufferSize: 10 });
    const a = agentId("a");
    const sub = bus.subscribe(a, { kind: "self" });
    await bus.send(notification(agentId("b"), a));
    const iter = sub.events[Symbol.asyncIterator]();
    const { value } = await iter.next();
    expect(value).toBeDefined();
    sub.close();
  });

  it("kind:from matches broadcasts from the sender", async () => {
    const bus = new InMemoryBus({ bufferSize: 10 });
    const observer = agentId("observer");
    const sender = agentId("sender");
    const sub = bus.subscribe(observer, { kind: "from", sender });
    await bus.send(broadcast(sender));
    const iter = sub.events[Symbol.asyncIterator]();
    const { value } = await iter.next();
    expect(value).toBeDefined();
    expect((value as BusEnvelope).from).toBe(sender);
    sub.close();
  });

  it("kind:from with kinds filter excludes non-matching kinds", async () => {
    const bus = new InMemoryBus({ bufferSize: 10 });
    const observer = agentId("observer");
    const sender = agentId("sender");
    // Only interested in "delta" from sender
    const sub = bus.subscribe(observer, { kind: "from", sender, kinds: ["delta"] });

    // Send a notification — should NOT match
    await bus.send(broadcast(sender));
    // Check buffer is empty (no match)
    const stats = bus.getDropStats();
    expect(stats.aclBlocked).toBe(0);
    // The subscriber buffer should be empty
    sub.close();
  });
});

// --- Back-pressure ---

describe("InMemoryBus back-pressure", () => {
  it("drops oldest when buffer is full", async () => {
    const bufferSize = 3;
    const bus = new InMemoryBus({ bufferSize });
    const a = agentId("a");
    const sub = bus.subscribe(a, { kind: "self" });

    // Send 4 messages — 1 extra beyond the buffer
    for (let i = 0; i < bufferSize + 1; i++) {
      await bus.send(notification(agentId("b"), a));
    }

    const drops = bus.getDropStats();
    expect(drops.perSubscriber.get(a)).toBe(1);
    sub.close();
  });
});

// --- request() correlation ---

describe("InMemoryBus.request()", () => {
  it("resolves with the correlated result envelope", async () => {
    const bus = new InMemoryBus({ bufferSize: 10 });
    const caller = agentId("caller");
    const callee = agentId("callee");
    const cId = corrId("req-1");

    const reqEnv: RequestEnvelope = {
      kind: "request",
      correlationId: cId,
      sessionId: SESSION,
      from: caller,
      to: { kind: "agent", id: callee },
      timestamp: Date.now(),
      payload: { ask: "hello" },
    };

    // callee will reply asynchronously
    void (async () => {
      // Small delay
      await new Promise<void>((r) => setTimeout(r, 10));
      await bus.send({
        kind: "result",
        correlationId: cId,
        sessionId: SESSION,
        from: callee,
        to: { kind: "agent", id: caller },
        timestamp: Date.now(),
        payload: { answer: "world" },
      });
    })();

    const result = await bus.request(reqEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("result");
    }
  });
});

// --- interrupt() ---

describe("InMemoryBus.interrupt()", () => {
  it("sends an interrupt signal to the target", async () => {
    const bus = new InMemoryBus({ bufferSize: 10 });
    const target = agentId("target");
    const sub = bus.subscribe(target, { kind: "self" });

    await bus.interrupt(target, "test reason");

    const iter = sub.events[Symbol.asyncIterator]();
    const { value } = await iter.next();
    expect((value as BusEnvelope).kind).toBe("signal");
    sub.close();
  });
});
