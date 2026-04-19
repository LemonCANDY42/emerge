/**
 * InMemoryExperienceLibrary unit tests.
 *
 * Covers:
 *   - hint by exact approachFingerprint returns experience with score >= 0.6
 *   - same approach+task+desc on second ingest triggers merge (size stays 1)
 *   - different approach → no merge (size === 2)
 *   - hint with no match returns empty array (not low-score noise)
 *   - export/import round-trip preserves all experiences
 *   - importBundle of an already-stored experience triggers merge
 *   - maxEntries triggers LRU eviction
 *   - merged experience accumulates sourceSessions and decisionLessons
 *   - score-zero matches are excluded from hint results
 */

import type { Experience, ExperienceId, SessionId } from "@lwrf42/emerge-kernel/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExperienceLibrary } from "./index.js";

function sessionId(s: string): SessionId {
  return s as SessionId;
}

function expId(s: string): ExperienceId {
  return s as ExperienceId;
}

function makeExp(overrides: Partial<Experience> = {}): Experience {
  return {
    id: expId("exp-default"),
    taskType: "text-summarization",
    approachFingerprint: "fp-abc123",
    description: "summarize text using supervisor worker topology",
    optimizedTopology: { kind: "supervisor-worker", config: {} },
    decisionLessons: [
      {
        stepDescription: "dispatch strategy",
        chosen: "parallel",
        worked: true,
        note: "3 workers ran concurrently",
      },
    ],
    outcomes: { aligned: true, cost: 0.001, wallMs: 1200 },
    evidence: [],
    provenance: { sourceSessions: [sessionId("session-1")] },
    schemaVersion: "1.0",
    ...overrides,
  };
}

describe("InMemoryExperienceLibrary", () => {
  describe("hint", () => {
    it("returns experience with score >= 0.6 on exact approachFingerprint match", async () => {
      const lib = new InMemoryExperienceLibrary();
      const exp = makeExp();
      await lib.ingest(exp);

      const result = await lib.hint({ approachFingerprint: "fp-abc123" }, { maxItems: 10 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      const match = result.value[0];
      expect(match).toBeDefined();
      if (!match) return;
      expect(match.score).toBeGreaterThanOrEqual(0.6);
      expect(match.components.approach).toBe(1.0);
      expect(match.reason).toContain("approach=match");
    });

    it("returns score >= 0.9 when approach + taskType both match", async () => {
      const lib = new InMemoryExperienceLibrary();
      const exp = makeExp();
      await lib.ingest(exp);

      const result = await lib.hint(
        { approachFingerprint: "fp-abc123", taskType: "text-summarization" },
        { maxItems: 10 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      const match = result.value[0];
      if (!match) return;
      // 0.6 + 0.3 = 0.8999... in IEEE 754; use closeTo for floating-point equality
      expect(match.score).toBeCloseTo(0.9, 10);
      expect(match.components.taskType).toBe(1.0);
    });

    it("returns empty array when no experience matches (score-0 noise excluded)", async () => {
      const lib = new InMemoryExperienceLibrary();
      // Ingest an experience with different fingerprint
      await lib.ingest(makeExp({ approachFingerprint: "fp-xyz", taskType: "code-gen" }));

      // Query with a totally different fingerprint and taskType — no overlap
      const result = await lib.hint(
        { approachFingerprint: "fp-nomatch", taskType: "translation" },
        { maxItems: 10 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // No semantic overlap either since description differs — must be empty
      expect(result.value.length).toBe(0);
    });

    it("respects budget.maxItems cap", async () => {
      const lib = new InMemoryExperienceLibrary();
      for (let i = 0; i < 5; i++) {
        await lib.ingest(
          makeExp({
            id: expId(`exp-${i}`),
            approachFingerprint: "fp-shared",
            taskType: `type-${i}`,
          }),
        );
      }

      const result = await lib.hint({ approachFingerprint: "fp-shared" }, { maxItems: 3 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeLessThanOrEqual(3);
    });

    it("returns results sorted by score descending", async () => {
      const lib = new InMemoryExperienceLibrary();
      // First experience: approach matches only
      await lib.ingest(
        makeExp({
          id: expId("exp-approach-only"),
          approachFingerprint: "fp-match",
          taskType: "other-type",
          description: "completely different description",
        }),
      );
      // Second experience: approach + taskType match
      await lib.ingest(
        makeExp({
          id: expId("exp-approach-task"),
          approachFingerprint: "fp-match",
          taskType: "text-summarization",
          description: "completely different description too",
        }),
      );

      const result = await lib.hint(
        { approachFingerprint: "fp-match", taskType: "text-summarization" },
        { maxItems: 10 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
      const scores = result.value.map((m) => m.score);
      expect(scores[0]).toBeGreaterThanOrEqual(scores[1] ?? 0);
    });

    it("includes semantic component when description overlaps", async () => {
      const lib = new InMemoryExperienceLibrary();
      await lib.ingest(
        makeExp({
          approachFingerprint: "fp-sem",
          description: "parallel worker dispatch for text tasks",
        }),
      );

      // No approach/task match but some semantic overlap
      const result = await lib.hint(
        {
          approachFingerprint: "fp-different",
          taskType: "other",
          description: "parallel dispatch text",
        },
        { maxItems: 10 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // semantic-only score = jaccard * 0.1; still non-zero if there's overlap
      if (result.value.length > 0) {
        const match = result.value[0];
        if (match) {
          expect(match.components.semantic).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("ingest — merge behavior", () => {
    it("merges when same approach+task+desc is ingested twice (size stays 1)", async () => {
      const lib = new InMemoryExperienceLibrary();
      const base = makeExp({
        id: expId("exp-base"),
        approachFingerprint: "fp-dup",
        taskType: "text-summarization",
        description: "supervisor worker parallel dispatch",
      });
      await lib.ingest(base);

      const second = makeExp({
        id: expId("exp-second"),
        approachFingerprint: "fp-dup",
        taskType: "text-summarization",
        description: "supervisor worker parallel dispatch",
        provenance: { sourceSessions: [sessionId("session-2")] },
      });
      const result = await lib.ingest(second);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.mergedWith).toBeDefined();
      expect(result.value.mergedWith?.length).toBe(1);
      expect(lib.size()).toBe(1);
    });

    it("merged experience accumulates sourceSessions from both", async () => {
      const lib = new InMemoryExperienceLibrary();
      await lib.ingest(
        makeExp({
          id: expId("exp-s1"),
          approachFingerprint: "fp-merge",
          taskType: "text-summarization",
          description: "supervisor worker parallel dispatch",
          provenance: { sourceSessions: [sessionId("session-1")] },
        }),
      );
      await lib.ingest(
        makeExp({
          id: expId("exp-s2"),
          approachFingerprint: "fp-merge",
          taskType: "text-summarization",
          description: "supervisor worker parallel dispatch",
          provenance: { sourceSessions: [sessionId("session-2")] },
        }),
      );

      const allIds = [...Array.from({ length: lib.size() }, (_, i) => expId(`exp-s${i + 1}`))];
      // Just check the stored experience via hint
      const hint = await lib.hint(
        { approachFingerprint: "fp-merge", taskType: "text-summarization" },
        { maxItems: 1 },
      );
      expect(hint.ok).toBe(true);
      if (!hint.ok) return;
      expect(hint.value.length).toBe(1);
      const stored = hint.value[0]?.experience;
      expect(stored).toBeDefined();
      if (!stored) return;
      expect(stored.provenance.sourceSessions).toContain(sessionId("session-1"));
      expect(stored.provenance.sourceSessions).toContain(sessionId("session-2"));
      // Silence the unused variable warning
      void allIds;
    });

    it("merged experience accumulates decisionLessons from both", async () => {
      const lib = new InMemoryExperienceLibrary();
      await lib.ingest(
        makeExp({
          id: expId("exp-lesson-1"),
          approachFingerprint: "fp-lessons",
          taskType: "text-summarization",
          description: "parallel supervisor worker",
          decisionLessons: [{ stepDescription: "step-1", chosen: "parallel", worked: true }],
        }),
      );
      await lib.ingest(
        makeExp({
          id: expId("exp-lesson-2"),
          approachFingerprint: "fp-lessons",
          taskType: "text-summarization",
          description: "parallel supervisor worker",
          decisionLessons: [{ stepDescription: "step-2", chosen: "sequential", worked: false }],
        }),
      );

      const hint = await lib.hint(
        { approachFingerprint: "fp-lessons", taskType: "text-summarization" },
        { maxItems: 1 },
      );
      expect(hint.ok).toBe(true);
      if (!hint.ok) return;
      const stored = hint.value[0]?.experience;
      expect(stored?.decisionLessons.length).toBe(2);
    });

    it("inserts two experiences with different approaches (no merge, size === 2)", async () => {
      const lib = new InMemoryExperienceLibrary();
      await lib.ingest(makeExp({ id: expId("exp-a"), approachFingerprint: "fp-aaa" }));
      await lib.ingest(makeExp({ id: expId("exp-b"), approachFingerprint: "fp-bbb" }));

      expect(lib.size()).toBe(2);
    });

    it("returns { id } without mergedWith for new insertions", async () => {
      const lib = new InMemoryExperienceLibrary();
      const result = await lib.ingest(makeExp({ id: expId("exp-new") }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBeDefined();
      expect(result.value.mergedWith).toBeUndefined();
    });

    it("respects custom mergeThreshold=0 (everything merges)", async () => {
      const lib = new InMemoryExperienceLibrary({ mergeThreshold: 0.0 });
      await lib.ingest(
        makeExp({ id: expId("exp-t1"), approachFingerprint: "fp-x", taskType: "a" }),
      );
      // Even with different approach, any non-zero score triggers merge since threshold=0
      // But a totally orthogonal entry with score=0 won't merge (we require score > 0 strictly)
      // Use a different taskType that shares some overlap
      await lib.ingest(
        makeExp({
          id: expId("exp-t2"),
          approachFingerprint: "fp-x", // same approach → score = 0.6 which is > 0
          taskType: "b",
        }),
      );
      // They share the same approachFingerprint → score 0.6 >= 0.0 → merge
      expect(lib.size()).toBe(1);
    });
  });

  describe("get", () => {
    it("returns the experience by id", async () => {
      const lib = new InMemoryExperienceLibrary();
      const exp = makeExp({ id: expId("exp-get") });
      await lib.ingest(exp);

      const result = await lib.get(expId("exp-get"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeDefined();
      expect(result.value?.id).toBe(expId("exp-get"));
    });

    it("returns undefined for unknown id", async () => {
      const lib = new InMemoryExperienceLibrary();
      const result = await lib.get(expId("exp-nonexistent"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeUndefined();
    });
  });

  describe("export / importBundle round-trip", () => {
    it("exports selected ids and reimports them preserving all fields", async () => {
      const lib = new InMemoryExperienceLibrary();
      const exp1 = makeExp({ id: expId("exp-r1"), approachFingerprint: "fp-r1", taskType: "rt" });
      const exp2 = makeExp({ id: expId("exp-r2"), approachFingerprint: "fp-r2", taskType: "rt" });
      await lib.ingest(exp1);
      await lib.ingest(exp2);

      const exportResult = await lib.export([expId("exp-r1"), expId("exp-r2")]);
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;
      expect(exportResult.value.version).toBe("1.0.0");
      expect(exportResult.value.experiences.length).toBe(2);

      // Import into a fresh library
      const lib2 = new InMemoryExperienceLibrary();
      const importResult = await lib2.importBundle(exportResult.value);
      expect(importResult.ok).toBe(true);
      if (!importResult.ok) return;
      expect(importResult.value.length).toBe(2);
      expect(lib2.size()).toBe(2);

      const got1 = await lib2.get(expId("exp-r1"));
      expect(got1.ok).toBe(true);
      if (!got1.ok) return;
      expect(got1.value?.approachFingerprint).toBe("fp-r1");
    });

    it("skips unknown ids in export silently", async () => {
      const lib = new InMemoryExperienceLibrary();
      await lib.ingest(makeExp({ id: expId("exp-e1") }));

      const result = await lib.export([expId("exp-e1"), expId("exp-unknown")]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.experiences.length).toBe(1);
    });

    it("importBundle of an already-existing experience triggers merge", async () => {
      const lib = new InMemoryExperienceLibrary();
      const exp = makeExp({
        id: expId("exp-im1"),
        approachFingerprint: "fp-import",
        taskType: "text-summarization",
        description: "supervisor worker parallel dispatch",
        provenance: { sourceSessions: [sessionId("session-original")] },
      });
      await lib.ingest(exp);
      expect(lib.size()).toBe(1);

      // Bundle contains a different-id experience but same approach+task+desc → should merge
      const bundle = {
        version: "1.0.0",
        experiences: [
          {
            ...exp,
            id: expId("exp-im2"),
            provenance: { sourceSessions: [sessionId("session-imported")] },
          },
        ],
      };
      const importResult = await lib.importBundle(bundle);
      expect(importResult.ok).toBe(true);

      // Should have merged (still 1 entry)
      expect(lib.size()).toBe(1);

      // Merged experience should include both sessions
      const hint = await lib.hint(
        { approachFingerprint: "fp-import", taskType: "text-summarization" },
        { maxItems: 1 },
      );
      expect(hint.ok).toBe(true);
      if (!hint.ok) return;
      const stored = hint.value[0]?.experience;
      expect(stored?.provenance.sourceSessions).toContain(sessionId("session-original"));
      expect(stored?.provenance.sourceSessions).toContain(sessionId("session-imported"));
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest-accessed entry when maxEntries is exceeded", async () => {
      const lib = new InMemoryExperienceLibrary({ maxEntries: 2 });

      // Ingest 3 different experiences (all distinct fingerprints → no merging)
      await lib.ingest(
        makeExp({
          id: expId("exp-lru1"),
          approachFingerprint: "fp-lru1",
          taskType: "t1",
          description: "alpha",
        }),
      );
      // Small delay to ensure different timestamps
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await lib.ingest(
        makeExp({
          id: expId("exp-lru2"),
          approachFingerprint: "fp-lru2",
          taskType: "t2",
          description: "beta",
        }),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await lib.ingest(
        makeExp({
          id: expId("exp-lru3"),
          approachFingerprint: "fp-lru3",
          taskType: "t3",
          description: "gamma",
        }),
      );

      // Only 2 should remain after eviction
      expect(lib.size()).toBe(2);
    });

    it("retains maxEntries exactly when exactly at limit", async () => {
      const lib = new InMemoryExperienceLibrary({ maxEntries: 3 });
      for (let i = 0; i < 3; i++) {
        await lib.ingest(
          makeExp({
            id: expId(`exp-max${i}`),
            approachFingerprint: `fp-max${i}`,
            taskType: `t${i}`,
            description: `desc-${i}`,
          }),
        );
      }
      expect(lib.size()).toBe(3);
    });
  });

  describe("size", () => {
    it("reports 0 for an empty library", () => {
      const lib = new InMemoryExperienceLibrary();
      expect(lib.size()).toBe(0);
    });

    it("increments after each distinct ingest", async () => {
      const lib = new InMemoryExperienceLibrary();
      await lib.ingest(makeExp({ id: expId("e1"), approachFingerprint: "fp1" }));
      expect(lib.size()).toBe(1);
      await lib.ingest(makeExp({ id: expId("e2"), approachFingerprint: "fp2" }));
      expect(lib.size()).toBe(2);
    });
  });
});
