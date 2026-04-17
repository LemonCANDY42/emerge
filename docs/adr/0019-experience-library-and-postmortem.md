# ADR 0019 — Experience library + postmortem analyzer

**Status:** accepted
**Date:** 2026-04-17

## Context

Each session in current harnesses is amnesic. The harness does not get
smarter over time without retraining the model. This is wasteful: the
*structural* lessons (which topology worked for this approach, which
decomposition shape was optimal) are usable across future sessions
*regardless* of the underlying model.

We want a portable, shareable, mergeable library of these lessons.

## Decision

- `Experience` records are keyed by **problem-solving approach
  fingerprint** (not topic). A "code-refactor by progressive isolation"
  experience can hint a "data-pipeline-design by progressive isolation"
  session.
- A **Postmortem analyzer** is a kernel-aware role agent that runs after
  a session ends, reads its `SessionRecord`, and emits candidate
  experiences.
- `ExperienceLibrary.hint()` is invoked by surveillance at session start
  (and on demand) to surface relevant priors.
- Bundles are exportable / importable; on `ingest`, similar experiences
  auto-merge with provenance preserved.

## Alternatives considered

- **Topic-keyed.** Rejected: too narrow; misses the user-flagged value
  of approach-match across topics.
- **Eval datasets only.** Rejected: those are test fixtures, not
  reusable knowledge.

## Consequences

- Surveillance becomes the read-side of a self-improving loop (ADR 0029).
- Bundles are a community surface; the format must be versioned and
  signable.
