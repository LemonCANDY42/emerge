/**
 * Session replay — high-fidelity event log + deterministic replayer.
 *
 * Replay reads `events` in order, returning recorded outputs verbatim. The
 * model is never re-prompted in `record-replay` mode — sidesteps the
 * LLM-non-determinism trap entirely.
 */

import type { AgentState } from "./agent.js";
import type { BusEnvelope } from "./bus.js";
import type { AgentId, ContractId, Result, SessionId } from "./common.js";
import type { ProviderEvent, ProviderRequest } from "./provider.js";
import type { AssessmentInput, Recommendation } from "./surveillance.js";
import type { ToolInvocation, ToolResult } from "./tool.js";

export interface SessionRecord {
  readonly sessionId: SessionId;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly contractRef: ContractId;
  readonly events: readonly RecordedEvent[];
  readonly schemaVersion: string;
}

export type RecordedEvent =
  | { readonly kind: "envelope"; readonly at: number; readonly envelope: BusEnvelope }
  | {
      readonly kind: "provider_call";
      readonly at: number;
      readonly req: ProviderRequest;
      readonly events: readonly ProviderEvent[];
    }
  | {
      readonly kind: "tool_call";
      readonly at: number;
      readonly call: ToolInvocation;
      readonly result: ToolResult;
    }
  | {
      readonly kind: "surveillance_recommendation";
      readonly at: number;
      readonly input: AssessmentInput;
      readonly recommendation: Recommendation;
    }
  | {
      readonly kind: "decision";
      readonly at: number;
      readonly agent: AgentId;
      readonly choice: string;
      readonly rationale: string;
    }
  | {
      readonly kind: "lifecycle";
      readonly at: number;
      readonly agent: AgentId;
      readonly transition: AgentState;
    };

export interface ReplayCursor {
  readonly sessionId: SessionId;
  readonly index: number;
}

export interface Replayer {
  load(sessionId: SessionId): Promise<Result<SessionRecord>>;
  next(
    cursor: ReplayCursor,
  ): Promise<Result<{ readonly cursor: ReplayCursor; readonly event: RecordedEvent | null }>>;
}

export interface SessionRecorder {
  start(sessionId: SessionId, contract: ContractId): void;
  record(event: RecordedEvent): void;
  end(sessionId: SessionId): Promise<Result<SessionRecord>>;
}
