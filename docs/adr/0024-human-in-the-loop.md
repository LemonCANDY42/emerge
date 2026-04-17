# ADR 0024 — Human-in-the-loop is a primitive

**Status:** accepted
**Date:** 2026-04-17

## Context

`accept-edit` and `plan` modes need to surface decisions to a human
before proceeding. Pretending humans are "just another agent" works
poorly: humans are async, slow, and may walk away. Pretending humans are
a "tool" the agent calls works equally poorly: the agent forgets to call.

## Decision

- New bus envelope kinds: `human.request` / `human.reply` /
  `human.timeout`.
- The host (CLI / web / IDE) implements an `ApprovalQueue` that
  receives `human.request`s and emits responses.
- `human.request` carries a prompt, optional structured options, an
  optional schema, and a timeout.
- Modes can require human approval for specific effects (e.g.
  `accept-edit` triggers `human.request` for fs writes).

## Alternatives considered

- **Block on stdin.** Rejected: not async, not GUI-friendly, can't
  cancel.
- **Tool that returns immediately with a stub answer.** Rejected: tested
  in the wild as a way for agents to fool themselves.

## Consequences

- The agent state machine grows a `waiting_for_human` state.
- Tests can simulate humans by injecting `human.reply` envelopes.
