/**
 * Experience library + Postmortem.
 *
 * Postmortem analyzer (kernel-aware role) runs after a session ends, reads
 * the SessionRecord, and emits Experience candidates keyed by problem-solving
 * APPROACH (not topic). Surveillance reads Experiences as priors at session
 * start. Bundles can be exported / imported / community-shared and merged
 * with similarity-based optimization on ingest.
 */

import type { Verdict } from "./adjudicator.js";
import type { ArtifactHandle, ExperienceId, Result, SessionId } from "./common.js";
import type { SessionRecord } from "./replay.js";
import type { TopologySpec } from "./topology.js";

export interface Experience {
  readonly id: ExperienceId;
  readonly taskType: string;
  /** Stable hash describing the problem-solving approach (NOT the topic). */
  readonly approachFingerprint: string;
  readonly description: string;
  readonly optimizedTopology: TopologySpec;
  readonly decisionLessons: readonly DecisionLesson[];
  readonly outcomes: ExperienceOutcomes;
  readonly evidence: readonly ArtifactHandle[];
  readonly provenance: ExperienceProvenance;
  readonly schemaVersion: string;
}

export interface DecisionLesson {
  readonly stepDescription: string;
  readonly chosen: string;
  readonly alternatives?: readonly string[];
  readonly worked: boolean;
  readonly note?: string;
}

export interface ExperienceOutcomes {
  readonly aligned: boolean;
  readonly cost: number;
  readonly wallMs: number;
  readonly verdict?: Verdict;
}

export interface ExperienceProvenance {
  readonly sourceSessions: readonly SessionId[];
  readonly mergeHistory?: readonly ExperienceId[];
  readonly importedFrom?: string;
}

export interface HintQuery {
  readonly taskType?: string;
  readonly approachFingerprint?: string;
  readonly description?: string;
}

export interface HintBudget {
  readonly maxItems?: number;
  readonly maxTokens?: number;
}

export interface ExperienceMatch {
  readonly experience: Experience;
  readonly score: number;
  readonly components: Readonly<{
    approach?: number;
    taskType?: number;
    semantic?: number;
  }>;
  readonly reason: string;
}

export interface ExperienceBundle {
  readonly version: string;
  readonly experiences: readonly Experience[];
  readonly signature?: string;
}

export interface ExperienceLibrary {
  hint(query: HintQuery, budget: HintBudget): Promise<Result<readonly ExperienceMatch[]>>;
  ingest(
    exp: Experience,
  ): Promise<Result<{ readonly id: ExperienceId; readonly mergedWith?: readonly ExperienceId[] }>>;
  export(ids: readonly ExperienceId[]): Promise<Result<ExperienceBundle>>;
  importBundle(bundle: ExperienceBundle): Promise<Result<readonly ExperienceId[]>>;
  get(id: ExperienceId): Promise<Result<Experience | undefined>>;
}

export interface Postmortem {
  /** Analyze a finished SessionRecord and emit candidate experiences. */
  analyze(record: SessionRecord): Promise<Result<readonly Experience[]>>;
}
