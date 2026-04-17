# ADR 0005 — Tools, not nodes, are the checkpoint boundary

**Status:** accepted
**Date:** 2026-04-17

## Context

LangGraph's checkpointer saves state *between* nodes, not *inside* them.
A long-running node that touches many external systems can lose hours of
work on crash. The community has hit this trap repeatedly.

Replay-based durable execution (Temporal, DBOS, Cloudflare fibers) avoids
the trap by checkpointing at every Activity / function boundary — the
durable unit is the side-effect, not the workflow.

For agents, the analog is: each tool call is a side-effect with an
idempotency key.

## Decision

- Tools are the checkpoint boundary. The kernel persists `(tool_call_id,
  result)` after every tool returns.
- Tool invocations carry an idempotency key. Replays read the recorded
  result instead of re-executing.
- Tools that have *internal* progress (long-running shell, training jobs)
  use a `Progress` API the kernel persists, so resume can continue from a
  mid-tool checkpoint without re-doing earlier work.
- Replay never re-prompts the model; it reads recorded provider outputs.

## Alternatives considered

- **Checkpoint between agent steps.** Rejected: same trap LangGraph
  hits. A long-running tool inside a step would lose state.
- **Checkpoint after every provider call.** Rejected: inadequate, because
  side-effects happen in tools, not provider calls.

## Consequences

- Tools must be idempotent or carry their own idempotency. We document
  this expectation prominently.
- The persistence layer (M4) keys on `(session_id, tool_call_id)`.
