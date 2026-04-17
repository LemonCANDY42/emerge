# ADR 0030 — Tool-result projections

**Status:** accepted
**Date:** 2026-04-17

## Context

Tool outputs frequently dump too much into the model's context: 50KB of
HTML, a noisy stack trace, a giant JSON blob. Token cost balloons; the
model's attention scatters; PII may leak. The Token-frugality principle
demands a structural defense.

## Decision

- `AgentSpec.projections?: ToolResultProjection[]` declares per-tool
  (or wildcard `"*"`) transformer chains.
- Steps: `redact` (regex), `project` (to a Standard Schema), `cap`
  (max bytes), `summarize` (provider or rule), `to_handle` (externalize
  over a size threshold).
- The kernel applies projections **before** tool results enter the
  agent's working memory.

## Alternatives considered

- **Tool authors clean up.** Rejected: they don't, consistently.
- **Per-call truncation.** Rejected: too coarse; misses redaction and
  schema-projection opportunities.

## Consequences

- Tools can stay simple; agents see clean inputs.
- Projections are recorded in the session log so we can audit what the
  model actually saw.
