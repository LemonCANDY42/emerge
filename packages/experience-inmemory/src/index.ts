/**
 * @emerge/experience-inmemory — In-memory ExperienceLibrary implementation.
 *
 * Provides hint/ingest/export/importBundle/get with:
 *   - Weighted similarity scoring (approach 0.6, taskType 0.3, semantic 0.1)
 *   - Merge-on-ingest at configurable threshold (default 0.85)
 *   - LRU eviction when maxEntries is set
 *
 * This is the M3c2.5 "loop-proving" backend. Persistence comes in M5.
 * See ADR 0038 for design rationale.
 */

import { randomUUID } from "node:crypto";
import type {
  Experience,
  ExperienceBundle,
  ExperienceId,
  ExperienceLibrary,
  ExperienceMatch,
  HintBudget,
  HintQuery,
  Result,
} from "@emerge/kernel/contracts";

export interface InMemoryExperienceLibraryOptions {
  /**
   * Similarity score (0..1) above which ingest merges into an existing
   * experience instead of inserting a new one. Default 0.85.
   * The intent: same approach run twice produces ONE experience with two
   * source sessions, not two separate entries.
   */
  readonly mergeThreshold?: number;
  /**
   * Maximum number of experiences to retain. When exceeded, the
   * least-recently-accessed entry is evicted (LRU). Default Infinity.
   */
  readonly maxEntries?: number;
}

// Internal entry: wraps an Experience with an access timestamp for LRU tracking.
interface StoredEntry {
  experience: Experience;
  lastAccessed: number;
}

/**
 * Compute token-overlap Jaccard similarity between two strings.
 * Tokens are space-separated lowercased words. Returns 0 if either string is empty.
 */
function jaccardSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const tokenize = (s: string): Set<string> => {
    const tokens = new Set<string>();
    for (const t of s.toLowerCase().split(/\s+/)) {
      if (t.length > 0) tokens.add(t);
    }
    return tokens;
  };
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Score a query against a stored experience.
 * Returns { score, components, reason }.
 *
 * Weights:
 *   approach  0.6 — exact match on approachFingerprint
 *   taskType  0.3 — exact match on taskType
 *   semantic  0.1 — token-overlap Jaccard on description
 */
function scoreMatch(
  query: HintQuery,
  exp: Experience,
): { score: number; approach: number; taskType: number; semantic: number } {
  const approach =
    query.approachFingerprint !== undefined && query.approachFingerprint === exp.approachFingerprint
      ? 1.0
      : 0.0;

  const taskType = query.taskType !== undefined && query.taskType === exp.taskType ? 1.0 : 0.0;

  const semantic =
    query.description !== undefined && exp.description.length > 0
      ? jaccardSimilarity(query.description, exp.description)
      : 0.0;

  const score = approach * 0.6 + taskType * 0.3 + semantic * 0.1;
  return { score, approach, taskType, semantic };
}

function formatReason(approach: number, taskType: number, semantic: number): string {
  const parts: string[] = [];
  parts.push(`approach=${approach === 1 ? "match" : "miss"}`);
  parts.push(`task=${taskType === 1 ? "match" : "miss"}`);
  parts.push(`semantic=${semantic.toFixed(2)}`);
  return parts.join(",");
}

/**
 * Merge two experiences: combine provenance, lessons, and outcomes.
 * The `base` experience is updated with data from `incoming`.
 */
function mergeExperiences(base: Experience, incoming: Experience): Experience {
  const combinedSessions = [...base.provenance.sourceSessions];
  for (const s of incoming.provenance.sourceSessions) {
    if (!combinedSessions.includes(s)) {
      combinedSessions.push(s);
    }
  }

  const mergeHistory = [...(base.provenance.mergeHistory ?? []), base.id].filter(
    (id, idx, arr) => arr.indexOf(id) === idx,
  );

  // Keep latest verdict; sum cost and wallMs.
  const latestVerdict = incoming.outcomes.verdict ?? base.outcomes.verdict;
  const mergedOutcomes = {
    aligned: incoming.outcomes.aligned || base.outcomes.aligned,
    cost: base.outcomes.cost + incoming.outcomes.cost,
    wallMs: base.outcomes.wallMs + incoming.outcomes.wallMs,
    ...(latestVerdict !== undefined ? { verdict: latestVerdict } : {}),
  };

  return {
    ...base,
    decisionLessons: [...base.decisionLessons, ...incoming.decisionLessons],
    outcomes: mergedOutcomes,
    provenance: {
      ...base.provenance,
      sourceSessions: combinedSessions,
      mergeHistory,
    },
  };
}

export class InMemoryExperienceLibrary implements ExperienceLibrary {
  private readonly store = new Map<ExperienceId, StoredEntry>();
  private readonly mergeThreshold: number;
  private readonly maxEntries: number;

  constructor(opts?: InMemoryExperienceLibraryOptions) {
    this.mergeThreshold = opts?.mergeThreshold ?? 0.85;
    this.maxEntries = opts?.maxEntries ?? Number.POSITIVE_INFINITY;
  }

  /**
   * Query the library for experiences relevant to the given query.
   * Returns matches sorted by score descending, capped by budget.maxItems.
   * Score-0 matches are excluded — returning [] is honest when we have nothing.
   */
  async hint(query: HintQuery, budget: HintBudget): Promise<Result<readonly ExperienceMatch[]>> {
    const maxItems = budget.maxItems ?? 10;
    const matches: ExperienceMatch[] = [];

    for (const entry of this.store.values()) {
      const { score, approach, taskType, semantic } = scoreMatch(query, entry.experience);
      if (score === 0) continue;

      // Touch the entry for LRU tracking.
      entry.lastAccessed = Date.now();

      matches.push({
        experience: entry.experience,
        score,
        components: { approach, taskType, semantic },
        reason: formatReason(approach, taskType, semantic),
      });
    }

    matches.sort((a, b) => b.score - a.score);
    const limited = matches.slice(0, maxItems);
    return { ok: true, value: limited };
  }

  /**
   * Ingest an experience into the library.
   *
   * Algorithm:
   * 1. Score the incoming experience against all existing entries.
   * 2. If max score >= mergeThreshold: merge into the best match.
   * 3. Otherwise: insert as a new entry (using exp.id if set; else generate).
   * 4. Enforce maxEntries via LRU eviction.
   */
  async ingest(
    exp: Experience,
  ): Promise<Result<{ readonly id: ExperienceId; readonly mergedWith?: readonly ExperienceId[] }>> {
    // Find the best existing match using the experience's own fields as the query.
    let bestScore = 0;
    let bestId: ExperienceId | undefined;

    for (const [id, entry] of this.store.entries()) {
      // Don't merge an experience with itself (idempotent re-ingest).
      if (id === exp.id) continue;

      const { score } = scoreMatch(
        {
          approachFingerprint: exp.approachFingerprint,
          taskType: exp.taskType,
          description: exp.description,
        },
        entry.experience,
      );

      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    if (bestScore >= this.mergeThreshold && bestId !== undefined) {
      const existing = this.store.get(bestId);
      if (existing !== undefined) {
        const merged = mergeExperiences(existing.experience, exp);
        this.store.set(bestId, { experience: merged, lastAccessed: Date.now() });
        return { ok: true, value: { id: bestId, mergedWith: [bestId] } };
      }
    }

    // Insert new entry.
    const id: ExperienceId =
      exp.id && !this.store.has(exp.id) ? exp.id : (`exp-${randomUUID()}` as ExperienceId);

    this.store.set(id, {
      experience: { ...exp, id },
      lastAccessed: Date.now(),
    });

    this.evictIfNeeded();

    return { ok: true, value: { id } };
  }

  /**
   * Export selected experiences by id as a bundle.
   * Unknown ids are skipped silently.
   */
  async export(ids: readonly ExperienceId[]): Promise<Result<ExperienceBundle>> {
    const experiences: Experience[] = [];
    for (const id of ids) {
      const entry = this.store.get(id);
      if (entry !== undefined) {
        entry.lastAccessed = Date.now();
        experiences.push(entry.experience);
      }
    }
    return {
      ok: true,
      value: { version: "1.0.0", experiences },
    };
  }

  /**
   * Import a bundle by running each experience through ingest().
   * Merge-on-import is automatic (same threshold applies).
   */
  async importBundle(bundle: ExperienceBundle): Promise<Result<readonly ExperienceId[]>> {
    const ids: ExperienceId[] = [];
    for (const exp of bundle.experiences) {
      const result = await this.ingest(exp);
      if (!result.ok) return result;
      ids.push(result.value.id);
    }
    return { ok: true, value: ids };
  }

  /**
   * Retrieve a single experience by id.
   */
  async get(id: ExperienceId): Promise<Result<Experience | undefined>> {
    const entry = this.store.get(id);
    if (entry !== undefined) {
      entry.lastAccessed = Date.now();
    }
    return { ok: true, value: entry?.experience };
  }

  /**
   * Total count of stored experiences. Test/debug helper.
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Evict least-recently-accessed entries until store is within maxEntries.
   */
  private evictIfNeeded(): void {
    if (this.store.size <= this.maxEntries) return;

    // Sort by lastAccessed ascending (oldest first).
    const sorted = [...this.store.entries()].sort(
      ([, a], [, b]) => a.lastAccessed - b.lastAccessed,
    );

    const toEvict = this.store.size - this.maxEntries;
    for (let i = 0; i < toEvict; i++) {
      const entry = sorted[i];
      if (entry !== undefined) {
        this.store.delete(entry[0]);
      }
    }
  }
}
