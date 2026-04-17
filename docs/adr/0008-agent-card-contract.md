# ADR 0008 — Agent contracts (AgentCards)

**Status:** accepted
**Date:** 2026-04-17

## Context

Topology helpers, routers, surveillance, and (later) A2A interop all need
to ask the same questions about an agent: what tools? what modalities?
streams or not? interrupts honored? quality tier? max concurrency? who is
allowed to send to it?

Without a shared answer, every component re-invents capability discovery.
A2A's "Agent Cards" set the precedent.

## Decision

- Every agent publishes an `AgentCard` at spawn.
- Peers exchange cards via the bus `handshake` envelope on first contact
  and cache them for the session.
- Cards include `capabilities`, `io` schemas, `budget`, `termination`,
  `acl`, `lineage`, and (when applicable) `endpoints` for remote A2A
  interop.

## Alternatives considered

- **Per-component capability descriptors.** Rejected: redundant and
  inconsistent.
- **Implicit capabilities (infer from behavior).** Rejected: opaque,
  unreliable, and not auditable.

## Consequences

- The card shape becomes a versioned surface (handled in ADR 0010).
- Tests can assert capability invariants per agent.
