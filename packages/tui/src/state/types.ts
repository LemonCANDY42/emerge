/**
 * Pure state types for the TUI.
 *
 * All state is derived from a sequence of JsonlEvent values.
 * No React imports here — these types are usable in tests without Ink.
 */

import type { AgentId, AgentState } from "@lwrf42/emerge-kernel/contracts";

// ─── Agent lifecycle state ────────────────────────────────────────────────────

/**
 * AgentLifecycle uses the kernel's AgentState type directly.
 * Alias kept for clarity in components.
 */
export type AgentLifecycle = AgentState;

export interface AgentNode {
  readonly id: AgentId;
  readonly parentId: AgentId | undefined;
  readonly state: AgentLifecycle;
  /** role may be undefined if only lifecycle events (no handshake) were seen */
  readonly role: string | undefined;
}

// ─── Verdict feed ─────────────────────────────────────────────────────────────

export type VerdictKind = "aligned" | "partial" | "off-track" | "failed";

export interface VerdictEntry {
  readonly at: number;
  readonly from: AgentId;
  readonly kind: VerdictKind;
  readonly rationale: string;
}

// ─── Cost / token meter ───────────────────────────────────────────────────────

export interface AgentUsage {
  readonly agentId: AgentId;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly usd: number;
}

// ─── Pinned context ───────────────────────────────────────────────────────────

export interface PinnedItem {
  readonly at: number;
  readonly agent: AgentId;
  readonly rationale: string;
}

// ─── Top-level TUI state ──────────────────────────────────────────────────────

export interface TuiState {
  /** Topology: map from agentId to AgentNode. */
  readonly agents: ReadonlyMap<AgentId, AgentNode>;
  /** Verdict feed: most recent first, capped at MAX_VERDICTS. */
  readonly verdicts: readonly VerdictEntry[];
  /** Cost per agent. */
  readonly usage: ReadonlyMap<AgentId, AgentUsage>;
  /** Total USD across all agents. */
  readonly totalUsd: number;
  /** Has any usage event been seen? */
  readonly hasUsageData: boolean;
  /** Pinned context items (from decision events with choice === "pin"). */
  readonly pinned: readonly PinnedItem[];
  /** Total events seen (for status bar). */
  readonly eventCount: number;
  /** Kind histogram (for status bar). */
  readonly kindHistogram: ReadonlyMap<string, number>;
}

export const MAX_VERDICTS = 10;

export const EMPTY_STATE: TuiState = {
  agents: new Map(),
  verdicts: [],
  usage: new Map(),
  totalUsd: 0,
  hasUsageData: false,
  pinned: [],
  eventCount: 0,
  kindHistogram: new Map(),
};
