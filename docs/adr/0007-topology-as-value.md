# ADR 0007 — Topology is a value, not a class

**Status:** accepted
**Date:** 2026-04-17

## Context

Frameworks that bake topology into the runtime (CrewAI's "crew",
AutoGen's GroupChat, ADK's hierarchies) make it hard to: nest topologies
of different shapes; swap topologies without rewriting agents; experiment
with new topologies without forking the framework.

Production patterns mix patterns: hierarchical at the top, mesh at the
leaves; pipelines of swarms; debates among supervisors.

## Decision

- `Topology` is a *value* produced by helper functions in
  `@emerge/agents`: `supervisor-worker`, `worker-pool`, `swarm`, `mesh`,
  `tree`, `pipeline`, `debate`, plus user-defined kinds.
- The kernel runs any topology because it only knows about `agents`,
  `bus`, and `scheduler`.
- Topologies nest. A `tree` of `mesh`es is valid; a `swarm` of
  `pipeline`s is valid.
- Topology helpers refuse to assemble unless every member declares
  budgets and termination.

## Alternatives considered

- **Topology as a runtime class.** Rejected: locks us into one shape and
  fights nesting.
- **No first-class topology.** Rejected: leaves users to wire bus traffic
  by hand for every common pattern.

## Consequences

- The kernel stays small (no topology code).
- Helpers in `@emerge/agents` must keep up with the patterns the
  community wants. Adding a new pattern is a non-breaking change.
