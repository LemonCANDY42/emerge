# ADR 0003 — Model surveillance is a kernel concept, not a tool

**Status:** accepted
**Date:** 2026-04-17

## Context

The thesis: the harness should make a weaker model competent and a stronger
model devastating. To do that, the harness must measure the active model's
competence on the real task and adapt — decompose, scaffold, escalate, defer.

This capability could live in three places:
1. As a **tool** the agent calls explicitly.
2. As an **agent pattern** (a "supervisor" agent the user opts into).
3. As a **kernel concept** invoked around every step the kernel runs.

## Decision

Surveillance is a **kernel concept**: a contract (`Surveillance`) the kernel
calls before/after each step when the agent's `SurveillanceProfile` is
`active` or `strict`. Implementations are pluggable; the kernel does not
hard-code the assessment policy.

## Why not a tool

Putting surveillance behind a tool means the model has to *remember* to ask.
Weak models forget; that is exactly the failure mode surveillance is meant
to absorb. The whole point is that the harness watches even when the model
doesn't know to ask.

## Why not just a supervisor agent

A supervisor pattern is a fine *implementation* of surveillance, but treating
it as the only path forces every consumer to instantiate a full agent for
what is often a cheap policy decision. Kernel-level surveillance lets simple
implementations be O(microseconds) and complex implementations be full
supervisor topologies — same contract.

## Decomposition is opaque to the inner agent

When surveillance recommends `decompose`, the kernel runs the sub-steps
(possibly with sub-agents, possibly recursively) and returns the *result*
to the inner agent as a single tool result. The inner agent never sees the
recursive structure. This is what lets a 32k-context model contribute to a
task that would normally need 200k — it only ever holds one step at a time.

## Bounded recursion

Every assessment includes `decompositionDepth`. Implementations MUST refuse
to recurse past a configurable bound. A runaway decomposition loop is a
bigger failure mode than an oversized step.

## Consequences

- The kernel pays a constant per-step assessment cost, even in the
  best case (`proceed` with high confidence).
- We commit to a vendor-neutral shape for capability descriptors and step
  profiles. These shapes will need to evolve carefully.
- Surveillance becomes the obvious place for evaluator infrastructure to
  hook in: research-grade evals can subclass the contract.
