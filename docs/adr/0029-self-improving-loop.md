# ADR 0029 — Self-improving loop: experience → surveillance

**Status:** accepted
**Date:** 2026-04-17

## Context

Surveillance's job is to estimate whether the active model can handle a
step. Without empirical priors, those estimates are heuristic. With an
experience library that grows session-over-session, we can ground them.

## Decision

- `AssessmentInput` carries optional `experienceHints: ExperienceMatch[]`.
- The kernel's surveillance dispatcher queries
  `ExperienceLibrary.hint()` before assessment when a library is
  configured (`ExperienceAware.setLibrary`).
- Surveillance implementations may consult the hints to raise / lower
  difficulty estimates and to bias toward known-good topology shapes
  (`Experience.optimizedTopology`).

## Alternatives considered

- **One-shot model fine-tunes.** Rejected: requires retraining; also,
  experience is portable across models — fine-tunes are not.
- **Implicit through memory.** Rejected: memory recall is per-session;
  experiences are cross-session by design.

## Consequences

- Surveillance gets smarter with use.
- A community-shared experience bundle can fast-start a fresh
  installation.
