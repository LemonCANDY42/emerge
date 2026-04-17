# ADR 0014 — AgentBlueprint: specialists by composition, not subclassing

**Status:** accepted
**Date:** 2026-04-17

## Context

Specialized agents (legal, code, ops, research) tend to become bespoke
snowflakes — each a hand-written `AgentSpec` that drifts from the others.
Skills (Claude Code) compose procedural knowledge. We want the same plug-
and-play discipline for *agent shape itself*.

## Decision

- `AgentBlueprint` declares typed slots: `provider`, `memoryView`,
  `tools`, `surveillance`, `prompt`, optional `behavior` modules, and a
  `domainExtensions` map for proprietary plug-ins.
- Specialists are produced by binding a blueprint to concrete slot
  fillers — analogous to `interface` (blueprint) and `class` (spec).
- Slots are typed via Standard Schema (ADR 0025), so what binds to a slot
  is statically validated.

## Alternatives considered

- **Class-based inheritance.** Rejected: the framework's reach into agent
  behavior should not require subclassing.
- **Templates with string substitution.** Rejected: untyped, brittle.
- **Just functions.** Rejected: no discoverability or community-shareable
  unit.

## Consequences

- Adding a new specialist becomes a small composition exercise.
- The community can publish blueprints as packages.
- Two specialists with the same blueprint but different bindings will
  compare cleanly in telemetry / experience.
