# ADR 0009 — Loop / recursion / mutual-respawn safeguards

**Status:** accepted
**Date:** 2026-04-17

## Context

Infinite loops are 2026's #1 agent-engineering plague. The "denial of
wallet" attack — where a malicious or buggy prompt drives recursive agent
spawns that exhaust budget — is real. AWS Lambda automatically detects
recursive Lambda→Lambda invocations; agent harnesses overwhelmingly do
not.

The community-converged defense is layered:
1. Hard caps on every agent.
2. Cycle detection by fingerprinting tool/prompt repeats.
3. Bounded retry budget with retryable / non-retryable classification.
4. Spawn-lineage cycle detection (don't let A spawn a descendant that
   spawns A).
5. Depth bound on the spawn tree.

## Decision

- Per-agent `TerminationPolicy` is **mandatory**. The kernel refuses to
  spawn an agent without one.
- The scheduler tracks `SpawnLineage` and refuses spawns that exceed
  `maxDepth` or would form a cycle.
- The kernel runs a per-agent cycle guard: a sliding window of
  `(toolName, normalizedArgs, hash(result))` and `(providerId,
  hash(promptMessages))`. After `repeatThreshold` repeats in `windowSize`
  recent calls, the agent is interrupted.
- A single `RetryBudget` propagates through provider → tool → agent.
  Non-retryable categories (auth, schema, policy) are budget-0.

## Alternatives considered

- **Per-tool retry policies.** Rejected: amplifies. Tools, providers,
  agents independently retrying creates exponential storms.
- **Cycle detection in user code.** Rejected: every harness re-implements
  it badly. Make it kernel-default.
- **Soft caps with warnings.** Rejected: warnings without enforcement is
  how budgets are exceeded silently.

## Consequences

- Spawning an agent without a termination policy is a contract error;
  there is no "default" policy in the kernel — topology helpers provide
  defaults appropriate for their pattern.
- Cycle guard may false-positive on legitimately repetitive workflows;
  the threshold is per-agent tunable.
