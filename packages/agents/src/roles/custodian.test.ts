/**
 * buildCustodian unit tests.
 *
 * Covers: contract is deep-frozen; quota grant clamped to budgetCeiling;
 * pin writes through to mounted Memory.
 */

import type {
  AgentId,
  Budget,
  Contract,
  ContractId,
  CorrelationId,
  Memory,
  MemoryItem,
  MemoryTier,
  QuotaDecision,
  QuotaRequest,
  RecallBudget,
  RecallQuery,
  RecallResult,
  RecallScope,
  Result,
  SchemaRef,
} from "@lwrf42/emerge-kernel/contracts";
import { describe, expect, it } from "vitest";
import { buildCustodian } from "./custodian.js";

function agentId(s: string): AgentId {
  return s as AgentId;
}

function corrId(s: string): CorrelationId {
  return s as CorrelationId;
}

function passthruSchema(): SchemaRef {
  return { "~standard": { version: 1, vendor: "test", validate: (v) => ({ value: v }) } };
}

function makeContract(): Contract {
  return {
    id: "c1" as ContractId,
    goal: "Test contract",
    acceptanceCriteria: [],
    inputs: [],
    outputs: [],
    constraints: [],
    hash: "abc123",
  };
}

function makeQuotaRequest(from: AgentId, amount: Budget): QuotaRequest {
  return {
    correlationId: corrId("cid-1"),
    from,
    ask: amount,
    rationale: "need more budget",
  };
}

class InMemoryMemory implements Memory {
  readonly items: MemoryItem[] = [];
  private counter = 0;

  async append(
    rawItems: readonly Omit<MemoryItem, "id" | "createdAt">[],
  ): Promise<Result<readonly string[]>> {
    const ids: string[] = [];
    for (const item of rawItems) {
      const id = `m${++this.counter}`;
      this.items.push({ ...item, id, createdAt: Date.now() } as MemoryItem);
      ids.push(id);
    }
    return { ok: true, value: ids };
  }

  async recall(_q: RecallQuery, _s: RecallScope, _b: RecallBudget): Promise<Result<RecallResult>> {
    return { ok: true, value: { items: this.items, trace: { items: [], droppedForBudget: 0 } } };
  }

  async get(id: string): Promise<Result<MemoryItem | undefined>> {
    return { ok: true, value: this.items.find((i) => i.id === id) };
  }

  async retier(_id: string, _to: MemoryTier): Promise<Result<void>> {
    return { ok: true, value: undefined };
  }
}

const grantPolicy = (granted: Budget): QuotaDecision => ({
  kind: "grant",
  granted,
  rationale: "granted by policy",
});

describe("buildCustodian", () => {
  it("contract() is deeply frozen", () => {
    const { instance } = buildCustodian({
      id: agentId("cust"),
      contract: makeContract(),
      quotaPolicy: () => grantPolicy({}),
    });

    const contract = instance.contract();
    expect(Object.isFrozen(contract)).toBe(true);
    expect(() => {
      (contract as unknown as { goal: string }).goal = "hacked";
    }).toThrow();
  });

  it("quota grant is clamped to budgetCeiling", async () => {
    const ceiling: Budget = { tokensOut: 100 };
    const { instance } = buildCustodian({
      id: agentId("cust"),
      contract: makeContract(),
      quotaPolicy: () => grantPolicy({ tokensOut: 500 }),
      budgetCeiling: ceiling,
    });

    const req = makeQuotaRequest(agentId("agent"), { tokensOut: 500 });
    const decision = await instance.receiveQuotaRequest(req);

    // Grant should be clamped to ceiling
    expect(decision.kind).not.toBe("deny");
    if (decision.kind === "grant" || decision.kind === "partial") {
      expect((decision.granted.tokensOut ?? 0) <= 100).toBe(true);
    }
  });

  it("pin writes into mounted Memory", async () => {
    const memory = new InMemoryMemory();
    const build = buildCustodian({
      id: agentId("cust"),
      contract: makeContract(),
      quotaPolicy: () => grantPolicy({}),
      memory,
    });

    await build.setMemory(memory);

    // The initial contract pin should be in memory
    expect(memory.items.length).toBeGreaterThan(0);
    const contractPin = memory.items.find(
      // biome-ignore lint/complexity/useLiteralKeys: attributes is Record<string, unknown>, requires bracket access
      (i) => typeof i.attributes["type"] === "string" && i.attributes["type"] === "contract",
    );
    expect(contractPin).toBeDefined();
  });

  it("quota decisions are recorded in the ledger", async () => {
    const { instance } = buildCustodian({
      id: agentId("cust"),
      contract: makeContract(),
      quotaPolicy: () => grantPolicy({ tokensOut: 50 }),
    });

    const req = makeQuotaRequest(agentId("agent"), { tokensOut: 50 });
    await instance.receiveQuotaRequest(req);
    await instance.receiveQuotaRequest(req);

    const ledger = instance.resourceLedger();
    expect(ledger.entries.length).toBe(2);
  });
});
