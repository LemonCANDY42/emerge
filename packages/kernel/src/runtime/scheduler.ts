/**
 * Scheduler — per-agent step loop manager.
 *
 * Tracks budgets, enforces TerminationPolicy caps, checks CycleGuard before
 * each step, records BudgetUsage, and emits lifecycle events on the bus.
 */

import type {
  AgentId,
  AgentState,
  BudgetUsage,
  Bus,
  CorrelationId,
  SessionId,
  TerminationPolicy,
} from "../contracts/index.js";
import { CycleGuard } from "./cycle-guard.js";

export interface SchedulerAgentState {
  id: AgentId;
  policy: TerminationPolicy;
  usage: BudgetUsage;
  startedAt: number;
  iteration: number;
  state: AgentState;
  cycleGuard: CycleGuard;
  abortController: AbortController;
}

export interface StepResult {
  continue: boolean;
  reason?: string;
}

export class Scheduler {
  private readonly bus: Bus;
  private readonly agents = new Map<AgentId, SchedulerAgentState>();

  constructor(bus: Bus) {
    this.bus = bus;
  }

  register(agentId: AgentId, policy: TerminationPolicy): SchedulerAgentState {
    const state: SchedulerAgentState = {
      id: agentId,
      policy,
      usage: { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
      startedAt: Date.now(),
      iteration: 0,
      state: "idle",
      cycleGuard: new CycleGuard(policy.cycle.windowSize, policy.cycle.repeatThreshold),
      abortController: new AbortController(),
    };
    this.agents.set(agentId, state);
    return state;
  }

  get(agentId: AgentId): SchedulerAgentState | undefined {
    return this.agents.get(agentId);
  }

  unregister(agentId: AgentId): void {
    this.agents.delete(agentId);
  }

  /**
   * Pre-step check: returns whether the agent should continue.
   * Records the state and emits lifecycle event on the bus.
   */
  preStep(
    agentState: SchedulerAgentState,
    sessionId: SessionId,
    correlationId: CorrelationId,
  ): StepResult {
    const { policy, usage, startedAt, iteration } = agentState;

    if (agentState.abortController.signal.aborted) {
      return { continue: false, reason: "aborted" };
    }

    if (iteration >= policy.maxIterations) {
      return { continue: false, reason: `max_iterations(${policy.maxIterations})` };
    }

    const wallMs = Date.now() - startedAt;
    if (wallMs >= policy.maxWallMs) {
      return { continue: false, reason: `max_wall_ms(${policy.maxWallMs})` };
    }

    if (policy.budget.tokensIn !== undefined && usage.tokensIn >= policy.budget.tokensIn) {
      return { continue: false, reason: "budget.tokensIn" };
    }
    if (policy.budget.tokensOut !== undefined && usage.tokensOut >= policy.budget.tokensOut) {
      return { continue: false, reason: "budget.tokensOut" };
    }
    if (policy.budget.usd !== undefined && usage.usd >= policy.budget.usd) {
      return { continue: false, reason: "budget.usd" };
    }

    if (agentState.cycleGuard.shouldInterrupt(agentState.id)) {
      return { continue: false, reason: "cycle_guard" };
    }

    agentState.iteration++;
    return { continue: true };
  }

  recordUsage(agentState: SchedulerAgentState, delta: BudgetUsage): void {
    agentState.usage = {
      tokensIn: agentState.usage.tokensIn + delta.tokensIn,
      tokensOut: agentState.usage.tokensOut + delta.tokensOut,
      wallMs: agentState.usage.wallMs + delta.wallMs,
      toolCalls: agentState.usage.toolCalls + delta.toolCalls,
      usd: agentState.usage.usd + delta.usd,
    };
  }

  signal(agentId: AgentId, kind: "interrupt" | "terminate" | "pause" | "resume"): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    if (kind === "interrupt" || kind === "terminate") {
      state.abortController.abort(kind);
    } else if (kind === "pause") {
      state.state = "suspended";
    } else if (kind === "resume") {
      if (state.state === "suspended") state.state = "idle";
    }
  }

  setState(agentId: AgentId, s: AgentState): void {
    const state = this.agents.get(agentId);
    if (state) state.state = s;
  }

  emitLifecycle(
    agentId: AgentId,
    sessionId: SessionId,
    correlationId: CorrelationId,
    transition: AgentState,
  ): void {
    void this.bus.send({
      kind: "notification",
      correlationId,
      sessionId,
      from: "kernel" as AgentId,
      to: { kind: "broadcast" },
      timestamp: Date.now(),
      topic: "lifecycle" as never,
      payload: { agent: agentId, transition },
    });
  }
}
