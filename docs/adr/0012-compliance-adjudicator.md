# ADR 0012 — Compliance Adjudicator: separate evaluator gates completion

**Status:** accepted
**Date:** 2026-04-17

## Context

The producing agent is the worst possible judge of whether its output
satisfies the contract. Self-grading bias is well documented; harnesses
that let the producer self-mark "done" frequently complete sessions that
fail acceptance criteria.

Separating the producer from the evaluator is a long-standing software
engineering principle (separation of concerns; quis custodiet).

## Decision

- A session designates one **Adjudicator** agent in
  `KernelConfig.roles.adjudicator`.
- The Adjudicator reads the `Contract` from the Custodian and evaluates
  outputs against acceptance criteria.
- Verdicts: `aligned` / `partial` / `off-track` / `failed`.
- Unless `trustMode: "implicit"`, the kernel will not mark a session
  `completed` without an `aligned` verdict.

## Alternatives considered

- **Producer self-evaluates.** Rejected: bias.
- **Eval as a separate test phase.** Rejected: too late; the work is
  already burned.
- **Adjudicator as a tool the producer calls.** Rejected: producer can
  forget to call it.

## Consequences

- Sessions need a way to handle `off-track` / `failed` — either retry,
  escalate, or surface to a human. Topology helpers wire this.
- A session without an Adjudicator runs in trust mode; we surface this
  in telemetry and the CLI's mode indicator.
