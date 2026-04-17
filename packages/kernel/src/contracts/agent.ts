/**
 * Agent — a configured combination of provider, prompt, tools, memory view,
 * budget, supervisor relationship, lineage, ACL, and termination policy.
 * Agents are *values*, not classes.
 *
 * The kernel instantiates agents from `AgentSpec` into runtime `AgentHandle`
 * objects you can message, suspend, and reap. Bus messages live in `bus.ts`.
 */

import type { AgentAcl, AgentCapabilities, AgentCard } from "./agent-card.js";
import type { BusEnvelope } from "./bus.js";
import type { AgentId, Budget, BudgetUsage, ContractError, Result } from "./common.js";
import type { ToolResultProjection } from "./projection.js";
import type { ProviderId } from "./provider.js";
import type { TerminationPolicy } from "./termination.js";
import type { ToolName } from "./tool.js";

export interface AgentSpec {
  readonly id: AgentId;
  readonly role: string;
  readonly description?: string;
  readonly provider: ProviderRouting;
  readonly system: SystemPrompt;
  readonly toolsAllowed: readonly ToolName[];
  readonly memoryView: MemoryViewSpec;
  readonly budget: Budget;
  readonly termination: TerminationPolicy;
  readonly acl: AgentAcl;
  readonly capabilities: AgentCapabilities;
  readonly lineage: { readonly spawnedBy?: AgentId; readonly depth: number };
  /** Optional projections applied to tool results before they hit the agent's working memory. */
  readonly projections?: readonly ToolResultProjection[];
  /** When set, the kernel routes through surveillance before each step. */
  readonly surveillance?: SurveillanceProfile;
}

export type ProviderRouting =
  | { readonly kind: "static"; readonly providerId: ProviderId }
  | {
      readonly kind: "router";
      readonly preference: readonly ProviderId[];
      readonly criteria?: ProviderCriteria;
    };

export interface ProviderCriteria {
  readonly needsVision?: boolean;
  readonly needsThinking?: boolean;
  readonly latencyTier?: "interactive" | "batch";
  readonly maxUsdPerCall?: number;
}

export type SystemPrompt =
  | { readonly kind: "literal"; readonly text: string }
  | {
      readonly kind: "template";
      readonly templateId: string;
      readonly variables: Readonly<Record<string, string>>;
    };

/**
 * What this agent is allowed to see in memory.
 */
export interface MemoryViewSpec {
  readonly inheritFromSupervisor: boolean;
  readonly writeTags: readonly string[];
  readonly readFilter?: Readonly<Record<string, string | number | boolean>>;
}

export type SurveillanceProfile = "off" | "passive" | "active" | "strict";

export interface AgentSnapshot {
  readonly id: AgentId;
  readonly state: AgentState;
  readonly usage: BudgetUsage;
  readonly lastActivityAt: number;
}

export type AgentState =
  | "idle"
  | "thinking"
  | "calling_tool"
  | "waiting_for_message"
  | "waiting_for_human"
  | "suspended"
  | "completed"
  | "failed";

/**
 * Runtime handle returned by the kernel after spawning an agent.
 */
export interface AgentHandle {
  readonly id: AgentId;
  card(): AgentCard;
  send(envelope: BusEnvelope): Promise<Result<void, ContractError>>;
  snapshot(): Promise<AgentSnapshot>;
  events(): AsyncIterable<AgentSnapshot>;
}
