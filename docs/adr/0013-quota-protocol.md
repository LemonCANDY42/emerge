# ADR 0013 — Quota request/grant protocol

**Status:** accepted
**Date:** 2026-04-17

## Context

A child agent often discovers mid-flight that its initial budget is too
small to finish well — but cancelling and re-spawning loses context. The
opposite failure (silently exceeding budget) is worse.

We need a protocol where children can ask for more and the Custodian can
grant, deny, or partially grant atomically.

## Decision

- New bus envelope kinds: `quota.request` / `quota.grant` /
  `quota.deny` / `quota.partial`.
- The kernel routes `quota.request` to the designated Custodian.
- The Custodian's decision mutates the requesting agent's
  `TerminationPolicy.budget` **atomically** before the agent resumes.
  No race; no over-spend in the gap.
- All decisions are recorded in the Custodian's `QuotaLedger` (pinned).

## Alternatives considered

- **Children just exit and re-spawn larger.** Rejected: throws away
  context and progress.
- **Pre-allocate large budgets.** Rejected: defeats budgeting.
- **Children self-extend.** Rejected: removes the audit trail.

## Consequences

- Adds a round-trip when a child needs more budget. Acceptable; the
  alternative is silent budget exceedance.
- Cost meter (ADR 0022) and Custodian ledger are the audit surface.
