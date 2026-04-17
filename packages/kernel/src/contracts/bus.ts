/**
 * Bus — typed, streaming, bidirectional, addressable message graph.
 *
 * Inspired by the converged ACP/A2A model: agents have addresses, can
 * `send`/`subscribe`/`request`/`stream`/`interrupt`. Parents observe
 * children mid-flight; children can `query` parents back. Local-first;
 * remote (A2A) adapters layer on later.
 */

import type { Verdict } from "./adjudicator.js";
import type { AgentCard } from "./agent-card.js";
import type { AgentId, CorrelationId, Result, SessionId, TopicId, TraceContext } from "./common.js";
import type { ArtifactHandle } from "./common.js";
import type { QuotaDecision, QuotaRequest } from "./quota.js";

/**
 * Common envelope shell. Every message carries this.
 */
export interface EnvelopeBase {
  readonly correlationId: CorrelationId;
  readonly sessionId: SessionId;
  readonly from: AgentId;
  readonly to: Address;
  readonly timestamp: number;
  readonly traceContext?: TraceContext;
}

export type Address =
  | { readonly kind: "agent"; readonly id: AgentId }
  | { readonly kind: "topic"; readonly topic: TopicId }
  | { readonly kind: "broadcast" };

/**
 * The discriminated envelope union. Replaces the older 3-kind AgentMessage.
 */
export type BusEnvelope =
  | RequestEnvelope
  | DeltaEnvelope
  | ProgressEnvelope
  | QueryEnvelope
  | ReplyEnvelope
  | ResultEnvelope
  | SignalEnvelope
  | NotificationEnvelope
  | HandshakeEnvelope
  | QuotaRequestEnvelope
  | QuotaDecisionEnvelope
  | ArtifactPutEnvelope
  | ArtifactGetEnvelope
  | VerdictEnvelope
  | HumanRequestEnvelope
  | HumanReplyEnvelope
  | HumanTimeoutEnvelope
  | ExperienceHintEnvelope;

export interface RequestEnvelope extends EnvelopeBase {
  readonly kind: "request";
  readonly payload: unknown;
  readonly card?: AgentCard;
}

export interface DeltaEnvelope extends EnvelopeBase {
  readonly kind: "delta";
  /** Partial output: text token chunk, partial JSON, intermediate artifact, etc. */
  readonly chunk: unknown;
  /** Monotonic per-correlationId. */
  readonly seq: number;
}

export interface ProgressEnvelope extends EnvelopeBase {
  readonly kind: "progress";
  readonly percent?: number;
  readonly step?: string;
  readonly currentTool?: string;
  readonly note?: string;
}

export interface QueryEnvelope extends EnvelopeBase {
  readonly kind: "query";
  readonly question: string;
  readonly schema?: unknown;
}

export interface ReplyEnvelope extends EnvelopeBase {
  readonly kind: "reply";
  readonly answer: unknown;
}

export interface ResultEnvelope extends EnvelopeBase {
  readonly kind: "result";
  readonly payload: unknown;
  readonly artifacts?: readonly ArtifactHandle[];
}

export type SignalKind = "interrupt" | "pause" | "resume" | "terminate";
export interface SignalEnvelope extends EnvelopeBase {
  readonly kind: "signal";
  readonly signal: SignalKind;
  readonly reason?: string;
}

export interface NotificationEnvelope extends EnvelopeBase {
  readonly kind: "notification";
  readonly topic: TopicId;
  readonly payload: unknown;
}

export interface HandshakeEnvelope extends EnvelopeBase {
  readonly kind: "handshake";
  readonly card: AgentCard;
}

export interface QuotaRequestEnvelope extends EnvelopeBase {
  readonly kind: "quota.request";
  readonly request: QuotaRequest;
}

export interface QuotaDecisionEnvelope extends EnvelopeBase {
  readonly kind: "quota.grant" | "quota.deny" | "quota.partial";
  readonly decision: QuotaDecision;
}

export interface ArtifactPutEnvelope extends EnvelopeBase {
  readonly kind: "artifact.put";
  readonly bytesRef: string;
  readonly mediaType: string;
  readonly size: number;
}

export interface ArtifactGetEnvelope extends EnvelopeBase {
  readonly kind: "artifact.get";
  readonly handle: ArtifactHandle;
}

export interface VerdictEnvelope extends EnvelopeBase {
  readonly kind: "verdict";
  readonly verdict: Verdict;
}

export interface HumanRequestEnvelope extends EnvelopeBase {
  readonly kind: "human.request";
  readonly prompt: string;
  readonly options?: readonly string[];
  readonly schema?: unknown;
  readonly timeoutMs?: number;
}

export interface HumanReplyEnvelope extends EnvelopeBase {
  readonly kind: "human.reply";
  readonly reply: unknown;
}

export interface HumanTimeoutEnvelope extends EnvelopeBase {
  readonly kind: "human.timeout";
}

export interface ExperienceHintEnvelope extends EnvelopeBase {
  readonly kind: "experience.hint";
  readonly hints: readonly unknown[];
}

/**
 * Subscription target — by sender + kinds, by topic + kinds, or all envelopes
 * addressed to this agent.
 */
export type SubscriptionTarget =
  | {
      readonly kind: "from";
      readonly sender: AgentId;
      readonly kinds?: readonly BusEnvelope["kind"][];
    }
  | {
      readonly kind: "topic";
      readonly topic: TopicId;
      readonly kinds?: readonly BusEnvelope["kind"][];
    }
  | { readonly kind: "self" };

export interface BusBackpressureConfig {
  /** Max envelopes per subscription buffer; overflow drops oldest. */
  readonly bufferSize: number;
  /** Optional per-kind override. */
  readonly perKind?: Partial<Record<BusEnvelope["kind"], number>>;
}

export interface Subscription {
  readonly events: AsyncIterable<BusEnvelope>;
  close(): void;
}

export interface Bus {
  send(env: BusEnvelope): Promise<Result<void>>;
  subscribe(subscriber: AgentId, target: SubscriptionTarget): Subscription;
  /** Send a `request`, await a matching `result` (or `signal:terminate`/error). */
  request(env: RequestEnvelope): Promise<Result<ResultEnvelope>>;
  /** Send a `request`, expose the live stream of envelopes for that correlationId. */
  stream(env: RequestEnvelope): Subscription;
  interrupt(target: AgentId, reason?: string): Promise<Result<void>>;
}
