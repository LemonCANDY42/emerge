# ADR 0032 — Enforced post-step verification

**Status:** accepted
**Date:** 2026-04-17

## Context

The Compliance Adjudicator (ADR 0012) gates session completion but says nothing
about intra-session step quality. Agents that drift from their goal mid-run can
compound errors across many steps before the end-of-session verdict catches the
problem. High-stakes tasks (code deployment, financial transactions, multi-agent
workflows) benefit from a tighter feedback loop.

The surveillance system (ADR 0003) already observes step outcomes via
`observe()`. What is missing is a mechanism to **halt and correct** an agent
immediately after a step that fails an external quality check.

## Decision

Add an opt-in `VerificationConfig` to `KernelDeps`:

```ts
interface VerificationConfig {
  /** "per-step" | "on-failure" */
  mode: "per-step" | "on-failure";
  /** AgentId of the verifier; must be enrolled as an adjudicator role. */
  verifierId: AgentId;
  /** Milliseconds to wait for a verdict before proceeding. Default: 5000. */
  timeoutMs?: number;
}
```

When `mode === "per-step"`, the agent runner sends a `request` envelope to
`verifierId` after every tool-result observation (after surveillance `observe()`
completes). The verifier replies with a verdict envelope containing one of:

| Verdict | Agent-runner action |
|---|---|
| `aligned` | Continue normally |
| `off_track` | Inject a corrective `user` message into the conversation: `"[Verification: off_track] <rationale>"` |
| `failed` | Inject `"[Verification: failed] <rationale>"` — stronger signal that the current plan must change |

The injection is made before the next provider call, giving the model a chance
to self-correct without external interruption.

When `mode === "on-failure"` (not yet implemented), verification runs only when
the agent's tool call returned an error.

A 5-second (configurable) timeout prevents a slow or absent verifier from
stalling the agent indefinitely; the runner proceeds normally on timeout.

## Alternatives considered

- **End-of-session only** (status quo) — Catches problems too late; correction
  requires re-running the whole session.
- **Synchronous verifier in the hot path** — Blocks the agent runner on every
  step unconditionally. Rejected: unacceptable latency cost for most workloads;
  opt-in is better.
- **Surveillance-based inline correction** — `CalibratedSurveillance` emits
  `scaffold` recommendations; agent runner already reacts. Rejected: surveillance
  only sees metrics (cycle hits, budget), not semantic goal alignment.
- **Dedicated verification loop** — A separate agent watching the bus for
  all step events and emitting corrections. Rejected: requires custom topology
  wiring per deployment; the opt-in dep on Kernel is simpler.

## Consequences

- High-trust deployments can gate every step without changes to agent code.
- Verification is transparent: injected messages appear in the session log with
  a `[Verification: ...]` prefix, making audits straightforward.
- The feature is strictly opt-in; zero overhead when `VerificationConfig` is
  not set.
- Verifier agents must be implemented by callers; the kernel provides only the
  plumbing (request/reply on the bus, timeout, message injection).
