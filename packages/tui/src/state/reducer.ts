/**
 * Pure state reducer: given current TuiState + a JsonlEvent, return next TuiState.
 *
 * No side-effects. No React. Fully testable without Ink.
 */

import type { AgentId } from "@emerge/kernel/contracts";
import type { JsonlEvent } from "@emerge/kernel/contracts";
import {
  type AgentNode,
  type AgentUsage,
  EMPTY_STATE,
  MAX_VERDICTS,
  type PinnedItem,
  type TuiState,
  type VerdictEntry,
  type VerdictKind,
} from "./types.js";

/**
 * Apply a single event to state and return a new state.
 * This is the single source of truth for how events mutate TUI state.
 */
export function applyEvent(state: TuiState, event: JsonlEvent): TuiState {
  // Track total events and kind histogram
  const newCount = state.eventCount + 1;
  const kindKey = event.type;
  const newHistogram = new Map(state.kindHistogram);
  newHistogram.set(kindKey, (newHistogram.get(kindKey) ?? 0) + 1);

  const base: TuiState = { ...state, eventCount: newCount, kindHistogram: newHistogram };

  switch (event.type) {
    case "envelope":
      return applyEnvelope(base, event);

    case "lifecycle":
      return applyLifecycle(base, event);

    case "provider_call":
      return applyProviderCall(base, event);

    case "decision":
      return applyDecision(base, event);

    // These event types don't directly mutate TUI state but count toward histogram
    case "session.start":
    case "session.end":
    case "tool_call":
    case "surveillance_recommendation":
    case "span.start":
    case "span.end":
    case "span.event":
      return base;
  }
}

// ─── Envelope handler ─────────────────────────────────────────────────────────

function applyEnvelope(
  state: TuiState,
  event: Extract<JsonlEvent, { type: "envelope" }>,
): TuiState {
  const env = event.envelope;

  if (env.kind === "handshake") {
    return applyHandshake(state, env);
  }

  if (env.kind === "verdict") {
    return applyVerdict(state, event.at, env);
  }

  return state;
}

function applyHandshake(
  state: TuiState,
  env: Extract<import("@emerge/kernel/contracts").BusEnvelope, { kind: "handshake" }>,
): TuiState {
  const card = env.card;
  const existing = state.agents.get(card.id);
  const node: AgentNode = {
    id: card.id,
    parentId: card.lineage.spawnedBy,
    state: existing?.state ?? "idle",
    role: card.role,
  };

  const newAgents = new Map(state.agents);
  newAgents.set(card.id, node);
  return { ...state, agents: newAgents };
}

function applyVerdict(
  state: TuiState,
  at: number,
  env: Extract<import("@emerge/kernel/contracts").BusEnvelope, { kind: "verdict" }>,
): TuiState {
  const verdict = env.verdict;

  // Map Verdict kinds to VerdictKind (aligned/partial/off-track/failed)
  let kind: VerdictKind;
  let rationale: string;

  if (verdict.kind === "aligned") {
    kind = "aligned";
    rationale = verdict.rationale;
  } else if (verdict.kind === "partial") {
    kind = "partial";
    rationale = verdict.suggestion;
  } else if (verdict.kind === "off-track") {
    kind = "off-track";
    rationale = verdict.reason;
  } else {
    // "failed"
    kind = "failed";
    rationale = verdict.reason;
  }

  const entry: VerdictEntry = { at, from: env.from, kind, rationale };

  // Prepend; keep at most MAX_VERDICTS
  const newVerdicts: readonly VerdictEntry[] = [entry, ...state.verdicts].slice(0, MAX_VERDICTS);
  return { ...state, verdicts: newVerdicts };
}

// ─── Lifecycle handler ────────────────────────────────────────────────────────

function applyLifecycle(
  state: TuiState,
  event: Extract<JsonlEvent, { type: "lifecycle" }>,
): TuiState {
  const { agent, transition } = event;

  // If the agent has never appeared via handshake, root it under "(unknown parent)"
  const existing = state.agents.get(agent);
  const node: AgentNode = existing
    ? { ...existing, state: transition as AgentNode["state"] }
    : {
        id: agent,
        parentId: "(unknown parent)" as AgentId,
        state: transition as AgentNode["state"],
        role: undefined as string | undefined,
      };

  const newAgents = new Map(state.agents);
  newAgents.set(agent, node);
  return { ...state, agents: newAgents };
}

// ─── Provider call handler ────────────────────────────────────────────────────

function applyProviderCall(
  state: TuiState,
  event: Extract<JsonlEvent, { type: "provider_call" }>,
): TuiState {
  // Try to find which agent initiated this call. The ProviderRequest.agentId
  // is not in the schema contract; we use the "running" agent heuristic.
  // Walk events looking for a `stop` event with usage.
  let tokensIn = 0;
  let tokensOut = 0;
  let usd = 0;
  let foundUsage = false;

  for (const provEv of event.events) {
    if (provEv.type === "stop" && provEv.usage) {
      tokensIn += provEv.usage.tokensIn;
      tokensOut += provEv.usage.tokensOut;
      usd += provEv.usage.usd;
      foundUsage = true;
    }
  }

  if (!foundUsage) return state;

  // Best-effort attribution: find the agent most recently transitioned to "running"
  const agentId = findRunningAgent(state) ?? ("(unattributed)" as AgentId);

  const existing = state.usage.get(agentId);
  const updated: AgentUsage = {
    agentId,
    tokensIn: (existing?.tokensIn ?? 0) + tokensIn,
    tokensOut: (existing?.tokensOut ?? 0) + tokensOut,
    usd: (existing?.usd ?? 0) + usd,
  };

  const newUsage = new Map(state.usage);
  newUsage.set(agentId, updated);

  // Recompute total
  let totalUsd = 0;
  for (const u of newUsage.values()) {
    totalUsd += u.usd;
  }

  return { ...state, usage: newUsage, totalUsd, hasUsageData: true };
}

function findRunningAgent(state: TuiState): AgentId | undefined {
  // "thinking" is the kernel's active state when the model is being called.
  // "calling_tool" is when a tool is executing.
  // Either of these represents "the agent that generated this provider call."
  for (const node of state.agents.values()) {
    if (node.state === "thinking" || node.state === "calling_tool") return node.id;
  }
  return undefined;
}

// ─── Decision handler ─────────────────────────────────────────────────────────

function applyDecision(
  state: TuiState,
  event: Extract<JsonlEvent, { type: "decision" }>,
): TuiState {
  if (event.choice !== "pin") return state;

  const item: PinnedItem = {
    at: event.at,
    agent: event.agent,
    rationale: event.rationale,
  };

  return { ...state, pinned: [...state.pinned, item] };
}

/**
 * Apply a sequence of events to produce a final state.
 * Used to replay a full session from scratch.
 */
export function applyEvents(events: readonly JsonlEvent[]): TuiState {
  let state = EMPTY_STATE;
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}
