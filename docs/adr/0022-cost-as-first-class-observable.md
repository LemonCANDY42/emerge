# ADR 0022 — Cost as a first-class observable + budget dimension

**Status:** accepted
**Date:** 2026-04-17

## Context

Token-frugality is a stated principle, but cost-frugality is the user-
visible thing. Without first-class cost accounting, "denial of wallet"
attacks (ADR 0009) can still bleed budgets even when token caps hold —
because providers price differently and silently.

## Decision

- Providers report per-call USD via `BudgetUsage.usd` on `stop` events.
- The kernel runs a `CostMeter` that rolls up usage per agent /
  topology / contract.
- A pre-flight `forecast(input) → { p50, p95 }` API is available before
  expensive calls; surveillance and routers may consult it.
- Cost is a budget dimension; cost ceilings are enforced like tokens.
- Cost-overshoot is a signal `Surveillance.observe()` consumes; it can
  trigger `decompose` or `escalate` recommendations.

## Alternatives considered

- **Cost as a derived metric in telemetry only.** Rejected: deriving
  costs makes them lag-bound and unenforceable in real time.
- **Per-provider cost trackers.** Rejected: every consumer re-implements
  rollup.

## Consequences

- Provider implementations must report usage accurately. We ship a
  reference rate table per provider.
- Forecast accuracy improves as the experience library accumulates
  outcomes (ADR 0029).
