# ADR 0004 — Memory: multi-strategy associative recall, with a trace

**Status:** accepted
**Date:** 2026-04-17

## Context

Most agent memory systems pick one retrieval strategy (vector similarity,
or graph traversal, or BM25) and ship it. The 2026 landscape shows that
single-strategy retrieval is the dominant failure mode of cross-session
recall: temporal questions die in pure vector stores; multi-hop questions
die in pure BM25; everything dies when the index is stale.

The Hindsight pattern (semantic + BM25 + graph traversal + temporal +
cross-encoder rerank) is the closest research-grade analog to what we
want.

## Decision

- The `Memory` contract exposes a single `recall(query, scope, budget)`
  method.
- Implementations blend multiple strategies. The default blend is
  semantic + structural + temporal + causal. Other strategies may be added
  behind the same contract.
- Every recall returns a `RecallTrace` with per-item score components.
  "Why did you remember this?" is a first-class question.
- Compression runs out-of-band across tiers (working → summary → semantic
  → archived). On-demand recall never blocks on compression.

## Alternatives considered

- **One strategy, swappable.** Rejected: implementations would re-do the
  blend every time. Better to make the blend canonical and let
  alternatives plug in alongside, not replace.
- **Skip the trace.** Rejected: the trace is the primary debugging
  affordance. Without it, recall is opaque and incidents are unfixable.

## Consequences

- A `RecallTrace` is on every recall, even when scoring is trivial.
- Implementations are free to ship simpler blends; the contract does not
  prescribe the algorithm — only the explainability obligation.
