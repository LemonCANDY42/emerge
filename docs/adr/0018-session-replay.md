# ADR 0018 — Session replay is a first-class kernel concern

**Status:** accepted
**Date:** 2026-04-17

## Context

Without a high-fidelity record of what happened in a session, we cannot:
- Reproduce a bug.
- Run a postmortem.
- Distill experiences for the library.
- Honestly claim "reproducibility" for any tier.

LangGraph offers per-node checkpointing (insufficient — see ADR 0005).
Inspect AI offers eval-time recording (test-time only).

## Decision

- The kernel ships a `SessionRecorder` and `Replayer`.
- `SessionRecord` is a canonical, ordered, append-only log of typed
  `RecordedEvent`s: bus envelopes, provider calls (request + events),
  tool calls (invocation + result), surveillance recommendations,
  decisions, and lifecycle transitions.
- `record-replay` reproducibility tier (ADR 0023) reads from this log
  and never re-prompts the model.
- The recorder is on by default; mode can disable it (e.g. `bypass`
  with explicit opt-out).

## Alternatives considered

- **Telemetry only (OTel spans).** Rejected: spans are summaries; replay
  needs the raw artifacts.
- **Provider-level transcripts only.** Rejected: misses bus envelopes,
  surveillance, lifecycle.

## Consequences

- Session records can grow large. Artifact handles (ADR 0015) keep them
  light by externalizing payloads.
- A versioned `schemaVersion` on `SessionRecord` lets us evolve the log
  shape without breaking older replays.
