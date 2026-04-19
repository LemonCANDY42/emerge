/**
 * buildPostmortem — constructs an in-process Postmortem instance + its AgentSpec.
 *
 * The Postmortem:
 *   - Runs after kernel.endSession() finishes
 *   - Calls analyze(record) with the SessionRecord
 *   - Returns produced Experience[] through a return path
 *
 * The kernel optionally invokes analyze() if a postmortem id is registered
 * in KernelConfig.roles.postmortem (M4 wiring). For M3a, callers invoke
 * instance.analyze() directly after endSession().
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  AgentId,
  AgentSpec,
  Budget,
  DecisionLesson,
  Experience,
  ExperienceId,
  Postmortem,
  RecordedEvent,
  Result,
  SessionId,
  SessionRecord,
} from "@lwrf42/emerge-kernel/contracts";

export interface BuildPostmortemOptions {
  readonly id: AgentId;
  readonly analyze: (record: SessionRecord) => Promise<Experience[]>;
}

export interface PostmortemBuild {
  readonly spec: AgentSpec;
  readonly instance: Postmortem;
}

class InProcessPostmortem implements Postmortem {
  private readonly _analyze: (record: SessionRecord) => Promise<Experience[]>;

  constructor(analyze: (record: SessionRecord) => Promise<Experience[]>) {
    this._analyze = analyze;
  }

  async analyze(record: SessionRecord): Promise<Result<readonly Experience[]>> {
    try {
      const experiences = await this._analyze(record);
      return { ok: true, value: experiences };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "E_POSTMORTEM_FAILED",
          message: `Postmortem analysis failed: ${String(err)}`,
          cause: err,
        },
      };
    }
  }
}

/**
 * Compute a stable approach fingerprint from the session's structural signature.
 *
 * Hashes the sequence of (tool names used, surveillance recommendation kinds,
 * decision choices) — these describe the problem-solving *approach*, not the
 * topic or session identity. SHA-256 → first 16 hex chars.
 *
 * This is the load-bearing fix over the old `session:${sessionId}` fingerprint:
 * two sessions that used the same approach produce the same fingerprint, so the
 * ExperienceLibrary can recognise and merge them. See ADR 0038.
 */
export function computeApproachFingerprint(record: SessionRecord): string {
  const parts: string[] = [];

  for (const event of record.events) {
    if (event.kind === "tool_call") {
      parts.push(`tool:${event.call.name}`);
    } else if (event.kind === "surveillance_recommendation") {
      parts.push(`surv:${event.recommendation.kind}`);
    } else if (event.kind === "decision") {
      // Truncate rationale to avoid topic contamination — keep only the choice label.
      parts.push(`dec:${event.choice}`);
    }
  }

  // If the session had no structured events, fall back to the topology shape
  // detected from envelope kinds so different topology types still differ.
  if (parts.length === 0) {
    const envelopeKinds = new Set<string>();
    for (const event of record.events) {
      if (event.kind === "envelope") {
        envelopeKinds.add(event.envelope.kind);
      }
    }
    for (const k of [...envelopeKinds].sort()) {
      parts.push(`env:${k}`);
    }
  }

  const raw = parts.join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Derive a task type from the session.
 *
 * Uses contractRef as the primary signal — it is stable across every run of
 * the same task and is always present in SessionRecord (required field). This
 * guarantees that the stored taskType matches what AgentRunner queries with
 * (which also uses contractId when available). See ADR 0038.
 *
 * Falls back to the first system prompt slice for sessions recorded before
 * contractRef was reliable, then to "generic" as the last resort.
 */
function deriveTaskType(record: SessionRecord): string {
  // Primary: contractRef is stable and always present — preferred over prompt
  // text, which can vary with memory injection, pinned context, etc.
  const contractRef = String(record.contractRef);
  if (contractRef && contractRef !== "undefined" && contractRef !== "") {
    return contractRef;
  }
  // Fallback: first system message slice (pre-M3c2.5 sessions without a contract).
  for (const event of record.events) {
    if (event.kind === "provider_call") {
      for (const msg of event.req.messages) {
        if (msg.role === "system" && msg.content.length > 0) {
          return msg.content.slice(0, 50);
        }
      }
    }
  }
  return "generic";
}

/**
 * Build a human-readable description from the session's system prompts.
 *
 * The AgentRunner queries `hint()` with description = spec.system.text (up to 200 chars).
 * Storing the union of all unique system prompts maximises semantic overlap
 * with those queries on the next session of the same task. See ADR 0038.
 */
function deriveDescription(record: SessionRecord): string {
  const seen = new Set<string>();
  for (const event of record.events) {
    if (event.kind === "provider_call") {
      for (const msg of event.req.messages) {
        if (msg.role === "system") {
          const text = msg.content.slice(0, 200);
          seen.add(text);
        }
      }
    }
  }
  if (seen.size > 0) {
    return [...seen].join(" | ");
  }
  // Fallback: structural summary when no provider calls are recorded.
  const toolCalls = record.events.filter((e) => e.kind === "tool_call").length;
  const envelopes = record.events.filter((e) => e.kind === "envelope").length;
  return `${String(record.contractRef)} via ${toolCalls} tool calls, ${envelopes} bus envelopes`;
}

/**
 * Check whether the session achieved an aligned verdict.
 * Scans envelope events for verdict envelopes of kind "aligned".
 */
function hasAlignedVerdict(events: readonly RecordedEvent[]): boolean {
  for (const event of events) {
    if (
      event.kind === "envelope" &&
      event.envelope.kind === "verdict" &&
      event.envelope.verdict.kind === "aligned"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extract decision lessons from the session record.
 * One lesson per recorded decision event.
 */
function extractDecisionLessons(events: readonly RecordedEvent[]): readonly DecisionLesson[] {
  const lessons: DecisionLesson[] = [];
  const aligned = hasAlignedVerdict(events);
  for (const event of events) {
    if (event.kind === "decision") {
      lessons.push({
        stepDescription: event.choice,
        chosen: event.choice,
        worked: aligned,
        note: event.rationale.slice(0, 200),
      });
    }
  }
  return lessons;
}

/**
 * Default postmortem analyzer that produces a stable, cross-session-matchable
 * Experience from a SessionRecord.
 *
 * Key design points (see ADR 0038):
 *   - approachFingerprint is computed from session structure (tools + surveillance +
 *     decisions), NOT the session id. Two sessions that took the same approach
 *     produce identical fingerprints → the ExperienceLibrary merges them.
 *   - taskType comes from the contract id (stable across sessions of the same task).
 *   - outcomes.aligned is derived from actual verdict envelopes in the record.
 *   - decisionLessons are extracted from recorded decision events.
 */
export function defaultAnalyze(record: SessionRecord): Promise<Experience[]> {
  const sessionId: SessionId = record.sessionId;
  const wallMs = (record.endedAt ?? Date.now()) - record.startedAt;
  const aligned = hasAlignedVerdict(record.events);
  const approachFingerprint = computeApproachFingerprint(record);
  const taskType = deriveTaskType(record);
  const decisionLessons = extractDecisionLessons(record.events);

  const exp: Experience = {
    id: `exp-${randomUUID()}` as ExperienceId,
    taskType,
    approachFingerprint,
    description: `${taskType} via ${record.events.filter((e) => e.kind === "tool_call").length} tool calls, ${record.events.filter((e) => e.kind === "envelope").length} bus envelopes`,
    optimizedTopology: { kind: "supervisor-worker", config: {} },
    decisionLessons,
    outcomes: {
      aligned,
      cost: 0,
      wallMs,
    },
    evidence: [],
    provenance: { sourceSessions: [sessionId] },
    schemaVersion: "1.0",
  };
  return Promise.resolve([exp]);
}

export function buildPostmortem(opts: BuildPostmortemOptions): PostmortemBuild {
  const instance = new InProcessPostmortem(opts.analyze);

  const budget: Budget = { tokensIn: 2_000, tokensOut: 1_000, wallMs: 60_000, usd: 0.5 };

  const spec: AgentSpec = {
    id: opts.id,
    role: "postmortem",
    description: "Post-session analyzer; runs after endSession()",
    provider: { kind: "router", preference: [] },
    system: {
      kind: "literal",
      text: "You are the Postmortem Analyzer. You analyze completed session records and extract learnable experiences.",
    },
    toolsAllowed: [],
    memoryView: {
      inheritFromSupervisor: false,
      writeTags: ["postmortem"],
    },
    budget,
    termination: {
      maxIterations: 1,
      maxWallMs: 60_000,
      budget,
      retry: { transient: 0, nonRetryable: 0 },
      cycle: { windowSize: 3, repeatThreshold: 3 },
      done: { kind: "predicate", description: "Postmortem does not iterate" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: [],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: false,
      interrupts: false,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
  };

  return { spec, instance };
}
