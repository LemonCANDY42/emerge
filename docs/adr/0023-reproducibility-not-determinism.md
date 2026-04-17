# ADR 0023 — Reproducibility, not determinism

**Status:** accepted
**Date:** 2026-04-17

## Context

It is tempting to claim that "same seed → same output" gives reproducible
agent runs. It does not. Across providers, inference servers,
hardware, and version bumps, even a fully-pinned call can diverge. A
harness that promises seed-based determinism is being dishonest.

The thing we *can* honestly promise is replay from a recorded log.

## Decision

Three honest tiers:

- **`record-replay`** — replay reads from a `SessionRecord` (ADR 0018);
  the model is never re-prompted. Fully reproducible regardless of model
  variance.
- **`pinned`** — pin seed / temperature / top-p where the provider
  supports it; record observed `Divergence` on replay or comparison.
  Best-effort.
- **`free`** — no pinning.

The harness explicitly does NOT promise that two fresh runs in `pinned`
mode produce identical outputs across providers / inference servers /
versions.

## Alternatives considered

- **Promise determinism via seeds.** Rejected: dishonest.
- **Skip the contract.** Rejected: leaves consumers with no way to ask
  for the strongest available reproducibility.

## Consequences

- Tests requiring exact reproducibility use `record-replay`.
- `pinned` is useful for A/B and divergence audits.
