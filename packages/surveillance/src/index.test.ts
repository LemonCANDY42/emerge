/**
 * CalibratedSurveillance unit tests.
 *
 * Covers: each assess() branch (proceed / decompose / scaffold / escalate / defer);
 * observe() updates rolling stats; cycle-hits decay; experience-hint scoring.
 */

import type {
  AgentId,
  AssessmentInput,
  ProviderCapabilities,
  StepObservation,
  StepProfile,
} from "@lwrf42/emerge-kernel/contracts";
import { describe, expect, it } from "vitest";
import { CalibratedSurveillance } from "./index.js";

function agentId(s: string): AgentId {
  return s as AgentId;
}

function caps(contextWindow: number): ProviderCapabilities {
  return {
    id: `mock-${contextWindow}`,
    claimed: {
      contextWindow,
      maxOutputTokens: 4096,
      nativeToolUse: true,
      streamingToolUse: false,
      vision: false,
      audio: false,
      thinking: false,
      latencyTier: "interactive",
    },
  };
}

function step(difficulty: StepProfile["difficulty"]): StepProfile {
  return {
    stepId: "test-step",
    difficulty,
    goal: "do something",
    tools: [],
  };
}

function input(
  providerId: string,
  difficulty: StepProfile["difficulty"],
  depth = 0,
): AssessmentInput {
  const c = caps(200_000);
  return {
    agent: agentId("test-agent"),
    providerId,
    capabilities: { ...c, id: providerId },
    step: step(difficulty),
    decompositionDepth: depth,
  };
}

function obs(agent: AgentId, success: boolean, cycleHits = 0): StepObservation {
  return {
    stepId: "test-step",
    agent,
    success,
    retries: 0,
    toolErrors: 0,
    selfCorrections: 0,
    wallMs: 100,
    cycleHits,
  };
}

describe("CalibratedSurveillance.assess()", () => {
  it("returns proceed when step is within the model envelope", async () => {
    const s = new CalibratedSurveillance({ maxDepth: 4 });
    s.runProbes({ capabilities: caps(200_000) });
    const rec = await s.assess(input("mock-200000", "trivial"));
    expect(rec.kind).toBe("proceed");
  });

  it("returns proceed at max depth to avoid infinite decomposition", async () => {
    const s = new CalibratedSurveillance({ maxDepth: 2 });
    const rec = await s.assess(input("mock-x", "research", 2));
    expect(rec.kind).toBe("proceed");
  });

  it("returns decompose when step exceeds model ceiling by >= 2 levels", async () => {
    const s = new CalibratedSurveillance({ maxDepth: 4 });
    // Small context window → ceiling = trivial
    s.runProbes({ capabilities: caps(1_000) });
    const rec = await s.assess(input("mock-1000", "large"));
    expect(rec.kind).toBe("decompose");
  });

  it("returns scaffold when cycle-hits are detected", async () => {
    const s = new CalibratedSurveillance({ maxDepth: 4 });
    s.runProbes({ capabilities: caps(200_000) });
    const agent = agentId("agent");
    s.notifyAssessment(agent, "mock-200000", "medium");
    await s.observe({ ...obs(agent, true, 3), stepId: "s1" });

    const rec = await s.assess(input("mock-200000", "medium"));
    expect(rec.kind).toBe("scaffold");
  });

  it("returns escalate when probe ceiling is trivial and step is large", async () => {
    const s = new CalibratedSurveillance({ maxDepth: 4, escalateTo: "strong-model" });
    s.runProbes({ capabilities: caps(1_000) });
    const rec = await s.assess(input("mock-1000", "large"));
    expect(rec.kind).toBe("escalate");
  });

  it("returns defer when budget overshoot rate is sustained at max depth", async () => {
    const s = new CalibratedSurveillance({
      maxDepth: 2,
      deferOnBudgetOvershoot: true,
    });
    s.runProbes({ capabilities: caps(200_000) });
    const agent = agentId("agent");
    s.notifyAssessment(agent, "mock-200000", "medium");
    // Trigger cost-overshoot entries
    await s.observe({ ...obs(agent, false), costOvershoot: 2.0, stepId: "s1" });
    await s.observe({ ...obs(agent, false), costOvershoot: 2.0, stepId: "s2" });

    const rec = await s.assess(input("mock-200000", "medium", 1));
    expect(rec.kind).toBe("defer");
  });
});

describe("CalibratedSurveillance.observe()", () => {
  it("updates rolling stats without error", async () => {
    const s = new CalibratedSurveillance({ maxDepth: 4 });
    s.runProbes({ capabilities: caps(200_000) });
    const agent = agentId("agent");
    s.notifyAssessment(agent, "mock-200000", "medium");
    await expect(s.observe(obs(agent, true))).resolves.toBeUndefined();
  });

  it("cycle-hits decay on successful observe", async () => {
    const s = new CalibratedSurveillance({ maxDepth: 4 });
    s.runProbes({ capabilities: caps(200_000) });
    const agent = agentId("agent");
    s.notifyAssessment(agent, "mock-200000", "medium");

    // Add cycle hit
    await s.observe({ ...obs(agent, true, 1), stepId: "s1" });
    // Scaffold should be recommended now
    let rec = await s.assess(input("mock-200000", "medium"));
    expect(rec.kind).toBe("scaffold");

    // Successful step → cycle-hits decay by 1
    s.notifyAssessment(agent, "mock-200000", "medium");
    await s.observe({ ...obs(agent, true, 0), stepId: "s2" });

    // Now cycle hits = 0, should proceed
    rec = await s.assess(input("mock-200000", "medium"));
    expect(rec.kind).toBe("proceed");
  });
});

describe("CalibratedSurveillance.envelope()", () => {
  it("returns undefined before any probes or observations", () => {
    const s = new CalibratedSurveillance({ maxDepth: 4 });
    expect(s.envelope("unknown")).toBeUndefined();
  });

  it("returns observed data after runProbes", () => {
    const s = new CalibratedSurveillance({ maxDepth: 4 });
    s.runProbes({ capabilities: caps(200_000) });
    const env = s.envelope("mock-200000");
    expect(env).toBeDefined();
    expect(env?.probeSuccessRate).toBe(0.9);
  });
});
