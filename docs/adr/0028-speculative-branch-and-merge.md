# ADR 0028 — Speculative branch-and-merge

**Status:** accepted
**Date:** 2026-04-17

## Context

When the optimal decomposition shape is unknown, running multiple
candidate decompositions in parallel — and judging a winner — beats
guessing once and committing. The losing branches still produced work
worth keeping (as cached experience).

## Decision

- `Branch` and `BranchMerger` are kernel contracts at M0; impl at M3.
- A `Branch` couples a `TopologySpec`, a `Workspace`, and a hypothesis
  string (what this branch is trying).
- `BranchMerger.judge` declares winners; `collectLessons` pulls
  `LessonRef`s from the losers for ingestion into the experience library.
- Surveillance can request a speculative branch as a recommendation kind
  in M3+.

## Alternatives considered

- **Guess once, commit.** Rejected: leaves perf on the table when the
  guess is wrong.
- **Run all branches to completion sequentially.** Rejected: defeats the
  point.

## Consequences

- Speculative runs cost more total compute. Mode/policy can disable.
- Lessons-from-losers becomes a primary feed for the experience library.
