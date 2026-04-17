# ADR 0010 — Wire-protocol-friendly bus envelope

**Status:** accepted
**Date:** 2026-04-17

## Context

The kernel's bus is local-first. Eventually, sub-agents may live in
remote processes — possibly speaking the converged ACP/A2A protocol.
Today's design choices either enable that future or block it.

A2A v0.3+ uses HTTP / SSE / JSON-RPC; ACP added delta-streaming and
bilateral peer-to-peer.

## Decision

- Envelope shape, addresses, correlation, trace context, and kinds are
  chosen to map cleanly to A2A messages and ACP delta streams. We add
  fields when both protocols converge on them.
- The kernel does not depend on any wire library today. A future
  `@emerge/bus-a2a` package will adapt.
- We treat the bus as the orchestration plane and MCP as the tool
  transport plane (separate concerns).

## Alternatives considered

- **Adopt A2A as the in-process bus.** Rejected: needless overhead
  in-process; ties our kernel to a specific wire format prematurely.
- **Roll a vanity protocol with no migration story.** Rejected: lock-out
  of the cross-vendor agent ecosystem we're betting on.

## Consequences

- Some fields (`traceContext`, `correlationId`, structured `Address`)
  exist primarily to ease the future remote adapter. They cost a few
  bytes today.
- Schema validation at the boundary (ADR 0025) makes wire serialization
  cheap to add.
