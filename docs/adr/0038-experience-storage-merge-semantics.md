# ADR 0038 — Experience storage, merge semantics, and loop closure

**Status:** accepted  
**Date:** 2026-04-18  
**Scope:** `packages/experience-inmemory`, `packages/agents/src/roles/postmortem.ts`,
           `packages/kernel/src/runtime/agent-runner.ts`

---

## Problem

ADR 0029 established the self-improving loop:
postmortem → `Experience` records → `ExperienceLibrary.hint()` → surveillance priors.
After M3c1 the kernel could *mount* a library and invoke the postmortem, but the
loop was not closed end-to-end:

1. **No backend.** `ExperienceLibrary` was a contract with zero implementations.
   The `experienceHints` field in `AssessmentInput` was always `undefined`.

2. **Hint fetch gated behind surveillance.** The `hint()` call in `AgentRunner`
   lived inside the `if (this.deps.surveillance && spec.surveillance === "active")`
   block. Any session that did not mount a `CalibratedSurveillance` — including
   the canonical `topology-supervisor-worker` demo — never called `hint()`.

3. **`taskType` mismatch risk.** `deriveTaskType` in `postmortem.ts` formerly
   prioritised the first system-prompt slice. `AgentRunner` queried with
   `stepProfile.goal.slice(0, 50)`, which equals `spec.system.text.slice(0, 50)`.
   These usually agreed, but the agreement was fragile: system messages grow with
   pinned context and memory injections across runs, so a future-proof identifier
   was needed.

---

## Decisions

### 1. Ship `@lwrf42/emerge-experience-inmemory` as the M3c2.5 loop-proving backend

An in-memory `InMemoryExperienceLibrary` that implements all five methods
(`hint / ingest / export / importBundle / get`) with:

- Weighted similarity scoring: **approach 0.6 / taskType 0.3 / semantic 0.1**.
- Merge-on-ingest at a configurable threshold (default **0.85**).
- LRU eviction when `maxEntries` is set (default: unbounded).

The score weights reflect that:
- `approachFingerprint` (structural hash) is the strongest signal — two sessions
  that used the same tools + surveillance + decisions should share priors even if
  their goals were phrased differently.
- `taskType` (contract id) is a reliable discriminator within a deployment.
- Semantic (Jaccard token overlap on `description`) breaks ties between
  structurally similar experiences for different contracts.

**Why in-memory for M3c2.5 and not SQLite?**  
Persistence (M4) and scale (M5) add complexity that the loop-proving milestone
doesn't need. In-memory is auditable, instant to start, and has no filesystem
dependency — exactly what a CI-clean demo requires. The `ExperienceLibrary`
contract is the stable surface; swapping in an SQLite backend in M5 changes
only the implementation, not the interface.

### 2. Move the experience hint fetch before the surveillance gate

`AgentRunner` used to fetch hints inside the `if (surveillance && active)`
block. The fetch now happens whenever `experienceLibrary` is mounted,
unconditionally:

```
// before surveillance:
if (this.deps.experienceLibrary) {
  const hintResult = await this.deps.experienceLibrary.hint(query, budget);
  if (hintResult.ok) experienceHints = [...hintResult.value];
}

// inside surveillance (unchanged):
if (this.deps.surveillance && spec.surveillance === "active" || "strict") {
  const assessInput = { ..., experienceHints };
  await this.deps.surveillance.assess(assessInput);
}
```

This means:
- Sessions with no surveillance still call `hint()`, which is the "read" half of
  the loop and is cheap (in-memory scan, never blocks the hot path).
- When surveillance IS active, it receives the pre-fetched hints — unchanged.
- The `HintCountingLibrary` wrapper in the demo correctly counts calls even
  without surveillance, proving the loop is truly end-to-end.

### 3. Use `contractId` as `taskType` — in both query and storage

**Query side (`AgentRunner`):** `taskType` in the `hint()` query is now
`String(this.deps.contractId)` when a contract id is available, falling back to
`stepProfile.goal.slice(0, 50)` only when no contract is mounted.

**Storage side (`postmortem.deriveTaskType`):** `contractRef` from
`SessionRecord` is the primary signal. `SessionRecord.contractRef` is a required
(non-optional) field set by `Kernel.setSession(sessionId, contractId)`, so it is
always present. The former first-system-prompt slice becomes a last-resort
fallback for sessions recorded before this convention was established.

Why `contractId` beats the system-prompt slice:
- It is invariant to prompt phrasing, pinned-context additions, memory
  injection, and localization changes.
- Two runs of the same task always produce the same `taskType`, so the
  `taskType` component of `scoreMatch` returns 1.0 every time.
- It is short, deterministic, and human-readable in library dumps.

### 4. Stable `approachFingerprint` from session structure

`computeApproachFingerprint` hashes the sequence of:
```
tool:<name> | surv:<kind> | dec:<choice>
```
across all `RecordedEvent`s in the session. If no structured events are
recorded, it falls back to the sorted set of `BusEnvelope.kind` values seen.

The fingerprint encodes the problem-solving *approach* (tools used, surveillance
decisions, agent choices) rather than topic or identity. Two sessions that took
the same approach produce the same fingerprint → `ingest()` merges them into one
entry (raising the evidence base) instead of creating a duplicate.

---

## Alternatives considered

### A. Keep hints gated behind surveillance

**Rejected.** The experience loop is architecturally independent of the
surveillance assessment loop. Gating hint reads on surveillance being active
breaks the loop for any agent that doesn't declare `surveillance: "active"`.
The cost of an unconditional `hint()` call is one in-memory scan per step — well
within the "token cost is a design constraint" rule (no LLM tokens consumed).

### B. Use the system-prompt slice as `taskType`

**Rejected.** System prompts grow with pinned context, memory items, and
scaffold injections across runs. Two iterations of the *same* task with different
memory states would produce different slices → no `taskType` match → only the
semantic component contributes (weight 0.1) → score may fall below the match
threshold. `contractId` is immune to all of this.

### C. Use agent `id` or a UUID fingerprint

**Rejected.** Agent ids change between sessions (a new id can be assigned per
run). UUIDs are unique per session by definition — they defeat the whole point of
a cross-session experience library.

### D. Add `approachFingerprint` to the hint query on the runner side

Considered but deferred. `AgentRunner` doesn't have a stable structural
fingerprint at step-start time (it hasn't made provider calls yet). Computing a
predictive fingerprint would require materialising the session graph in advance,
which is speculative. The `taskType` match (weight 0.3) + semantic overlap
(weight 0.1) is sufficient to return the relevant experience when the query has
no fingerprint. On the next session of the *same* approach, the stored
fingerprint will match at 0.6 — merge semantics ensure this.

---

## What changes when M5 SQLite backend lands

The `ExperienceLibrary` contract is unchanged. The M5 migration:

1. Replace `InMemoryExperienceLibrary` with `SqliteExperienceLibrary` (or keep
   in-memory as a write-through cache in front of SQLite).
2. Tune `mergeThreshold` once real production data shows the distribution of
   fingerprint similarities. The default 0.85 is conservative; production may
   want 0.80 to merge more aggressively.
3. Add an embedding-backed semantic component to `scoreMatch`. The current
   Jaccard tokenisation is intentionally primitive — semantic weight is 0.1
   precisely because Jaccard is weak. An embedding cosine replaces Jaccard and
   may justify raising the semantic weight to 0.2–0.3.
4. `approachFingerprint` storage and indexing: add a B-tree index on
   `(taskType, approachFingerprint)` for the common lookup pattern.
5. `mergeHistory` in `ExperienceProvenance` is already the contract field for
   tracking lineage through merges — no schema changes needed.

**What must not change:** the `HintQuery` shape, the `Experience.taskType` /
`approachFingerprint` / `description` fields, and the score weight contract
(approach 0.6 / taskType 0.3 / semantic 0.1 are architectural invariants until
a benchmark demonstrates a better ratio).

---

## Consequences

### Positive

- The postmortem → experience → surveillance loop is end-to-end and demo-proven:
  `topology-supervisor-worker` run 2 receives ≥1 hint with results from run 1's
  experience without any surveillance infrastructure.
- `taskType = contractId` is a stable, deployment-specific key that doesn't
  drift with prompt engineering or memory growth.
- Merge-on-ingest means repeated runs of the same task produce **one** growing
  experience rather than N identical entries — better signal-to-noise for
  surveillance priors.
- The hint fetch is cheap and non-blocking; skipping on error means a library
  outage never kills an agent step.

### Negative / trade-offs

- Moving the hint fetch outside the surveillance gate means `hint()` is called on
  *every* agent step, even for agents where surveillance is off and no downstream
  consumer uses the hints. The in-memory implementation makes this negligible, but
  a slow I/O backend (e.g., network-bound SQLite) would need the call to be lazy
  or batched.
- `contractId` as `taskType` couples the experience key to kernel session
  management. If a caller never calls `setSession()` (and thus never sets a
  contract id), the runner falls back to the system-prompt slice — a regression
  to the pre-M3c2.5 state. Callers should always call `setSession()`.

---

## Implementation notes

- `packages/experience-inmemory/src/index.ts` — `InMemoryExperienceLibrary`;
  exported from `@lwrf42/emerge-experience-inmemory`.
- `packages/agents/src/roles/postmortem.ts` — `computeApproachFingerprint`,
  `defaultAnalyze`, `deriveTaskType` (now contractRef-first).
- `packages/kernel/src/runtime/agent-runner.ts` — hint fetch hoisted before the
  surveillance guard; `taskType` query key uses `this.deps.contractId`.
- `examples/topology-supervisor-worker/src/index.ts` — `HintCountingLibrary`
  wrapper; two-run proof that library size stays 1 (merged) and run 2 sees ≥1
  hint with results.
