# ADR 0016 — Pinned-context compression policy

**Status:** accepted
**Date:** 2026-04-17

## Context

Memory compression is mandatory for long sessions and cost control. But
some items (the contract, the topology snapshot, current progress, the
resource ledger) MUST survive every compression strategy or the agent
loses the plot.

Existing memory systems either compress everything (Mem0) or rely on the
agent to self-edit pinning (Letta). We want a structural guarantee
without depending on the agent's judgment.

## Decision

- `MemoryItem.pin?: PinScope` flags items that compression must not
  drop or summarize away.
- Built-in scopes: `contract`, `topology`, `progress`, `allocation`.
  User-defined scopes are allowed.
- Compression implementations MUST honor pins. We document the
  invariants in `pinned.ts` (`CompressionPolicyInvariants`).
- The Custodian's working memory ships these pins by construction.

## Alternatives considered

- **Optional pinning.** Rejected: optional safety nets aren't safety
  nets.
- **Pin via attributes (no first-class field).** Rejected: every
  implementation re-invents the convention.

## Consequences

- The pinned section can grow over a long session. We document a
  practical pin budget (a few hundred tokens) and recommend re-summarizing
  pin contents in the Custodian's behavior, not by dropping pins.
