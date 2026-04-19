# ADR 0011 — Contract Custodian is a kernel-aware role

**Status:** accepted
**Date:** 2026-04-17

## Context

A persistent failure mode of agent sessions: the original goal drifts as
context compresses. After enough compaction passes, the agent is
optimizing for what's left in context, not for what was asked.

We need a participant whose job is to remember the contract, the
topology, the progress, and the resource ledger — and whose memory is
structurally incapable of forgetting them.

## Decision

- A session designates one **Custodian** agent in
  `KernelConfig.roles.custodian`.
- The Custodian holds the master `Contract` immutably.
- The Custodian's working memory is required to host the contract,
  current topology snapshot, current progress, and resource ledger as
  `MemoryItem`s with `pin: PinScope` set.
- All `quota.*` envelopes are routed by the kernel to the Custodian.
- The Custodian owns the artifact pipeline (artifact lifecycle in
  ADR 0015).

## Alternatives considered

- **Contract as a tool.** Rejected: tools are forgotten between calls;
  the model has to ask. Custodian is the kernel watching even when the
  model doesn't.
- **Contract as a system-prompt constant.** Rejected: large contracts
  inflate every call's tokens. Pinned memory + on-demand recall is
  cheaper.
- **Library function.** Rejected: doesn't survive compression and
  doesn't give us quota mediation as a flow.

## Consequences

- A session without a Custodian degrades to "trust mode" — the kernel
  will not enforce contract invariants. We document this prominently.
- The Custodian's behavior lives in `@lwrf42/emerge-agents`; only the
  *interface* is in the kernel.
