/**
 * AgentCard — capability declaration + handshake.
 *
 * Inspired by A2A AgentCards. Every agent publishes one at spawn; peers cache
 * it on first contact via the bus `handshake` envelope. Used by topology
 * adapters, routers, surveillance, and (eventually) A2A interop on the wire.
 */

import type { AgentId, BlueprintId, Budget, SchemaRef } from "./common.js";
import type { TerminationPolicy } from "./termination.js";
import type { ToolName } from "./tool.js";

export interface AgentCard {
  readonly id: AgentId;
  readonly role: string;
  readonly description: string;
  readonly blueprint?: BlueprintId;
  readonly capabilities: AgentCapabilities;
  readonly io: { readonly accepts: SchemaRef; readonly produces: SchemaRef };
  readonly budget: Budget;
  readonly termination: TerminationPolicy;
  readonly acl: AgentAcl;
  readonly lineage: { readonly spawnedBy?: AgentId; readonly depth: number };
  /** Populated when the agent is reachable over the wire (future A2A interop). */
  readonly endpoints?: { readonly a2a?: string };
}

export interface AgentCapabilities {
  readonly tools: readonly ToolName[];
  readonly modalities: readonly ("text" | "image" | "audio" | "code")[];
  readonly languages?: readonly string[];
  readonly qualityTier: "draft" | "standard" | "premium";
  readonly streaming: boolean;
  readonly interrupts: boolean;
  readonly maxConcurrency: number;
}

/**
 * Receiver-side ACL controlling who may send what. Bus addressing is
 * session-global; permission to send is decided here, not by topology.
 */
export interface AgentAcl {
  readonly acceptsRequests: AcceptScope;
  readonly acceptsQueries: AcceptScope;
  readonly acceptsSignals: AcceptScope;
  readonly acceptsNotifications: AcceptScope;
}

export type AcceptScope =
  | "any"
  | "supervisor-only"
  | "topology-peers"
  | "custodian-and-adjudicator-only"
  | { readonly allow: readonly AgentId[] };
