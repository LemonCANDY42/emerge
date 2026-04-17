# ADR 0006 — Streaming, bidirectional, addressable bus envelope

**Status:** accepted
**Date:** 2026-04-17

## Context

Most agent harnesses' inter-agent comms are completion-only: the parent
sees nothing until the child returns. This rules out mid-flight
observability, mid-flight interrupts, and mid-flight clarification —
exactly the affordances the converged ACP/A2A specification has been
adding (delta streaming, push notifications, bidirectional queries).

A first-class bus that supports streaming, addressing, subscriptions, and
back-pressure is the foundation for both topologies and roles
(Custodian / Adjudicator).

## Decision

- The kernel ships a single `Bus` interface with `send` / `subscribe` /
  `request` / `stream` / `interrupt`.
- Envelopes are typed and discriminated by `kind` (request / delta /
  progress / query / reply / result / signal / notification / handshake /
  quota.* / artifact.* / verdict / human.* / experience.hint).
- Addresses are session-global. Permission to send is decided by the
  receiver's `AgentCard.acl`, not by topology.
- Subscriptions are buffered with bounded back-pressure (drop-oldest by
  default).

## Alternatives considered

- **Pure event emitter.** Rejected: lacks the request/reply correlation
  that sub-agent topologies need.
- **JSON-RPC.** Rejected: imposes a synchronous request/response shape
  that fights streaming and bidirectional flows.
- **Defer streaming to M3.** Rejected: streaming is the foundation of
  Custodian observability. Deferring it would force a re-design later.

## Consequences

- The kernel takes on back-pressure semantics; we document the
  drop-oldest default and how to override per-subscription.
- The envelope shape must map cleanly to A2A wire format later (see
  ADR 0010); we constrain ourselves up front.
