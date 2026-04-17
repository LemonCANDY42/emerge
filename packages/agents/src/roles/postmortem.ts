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

import { randomUUID } from "node:crypto";
import type {
  AgentId,
  AgentSpec,
  Budget,
  Experience,
  ExperienceId,
  Postmortem,
  Result,
  SessionId,
  SessionRecord,
} from "@emerge/kernel/contracts";

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
 * Default postmortem analyzer that extracts basic session stats as a single
 * Experience. Suitable for demos; replace with a real implementation.
 */
export function defaultAnalyze(record: SessionRecord): Promise<Experience[]> {
  const sessionId: SessionId = record.sessionId;
  const walledMs = (record.endedAt ?? Date.now()) - record.startedAt;
  const exp: Experience = {
    id: `exp-${randomUUID()}` as ExperienceId,
    taskType: "generic",
    approachFingerprint: `session:${record.sessionId}`,
    description: `Session ${String(record.sessionId)} completed with ${record.events.length} events`,
    optimizedTopology: { kind: "supervisor-worker", config: {} },
    decisionLessons: [],
    outcomes: {
      aligned: true,
      cost: 0,
      wallMs: walledMs,
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
