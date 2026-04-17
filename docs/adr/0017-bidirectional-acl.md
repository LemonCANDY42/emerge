# ADR 0017 — Bidirectional any-to-any messaging via receiver-side ACL

**Status:** accepted
**Date:** 2026-04-17

## Context

Restricting inter-agent traffic to a tree (parent ↔ child only) prevents
useful patterns like critic feedback to peers, blackboard reads in a
swarm, and Custodian/Adjudicator broadcasts. Conversely, unrestricted
messaging is a chaos vector.

## Decision

- Bus addressing is **session-global**: any agent can address any other
  agent's id (or a topic, or broadcast).
- Permission to send is decided by the **receiver's** `AgentCard.acl`.
- Topology helpers set sensible defaults per pattern; any agent can
  broaden them at spawn.
- Blocked sends return a typed `Result.error`, not an exception.

## Alternatives considered

- **Strict tree.** Rejected: too restrictive.
- **Sender-side capabilities (à la Erlang).** Rejected: requires
  capability passing on every spawn — fights the AgentCard's discoverable
  shape.

## Consequences

- Custodian and Adjudicator are reachable from anywhere by default.
- Audit logs include `acl_block` events for blocked sends.
