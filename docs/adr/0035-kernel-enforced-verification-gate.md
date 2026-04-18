# ADR 0035 — Kernel-enforced verification gate before task exit

**Status:** accepted
**Date:** 2026-04-18
**Extends:** ADR 0032 (enforced post-step verification)

## Context

ADR 0032 shipped opt-in per-step verification (the `VerificationConfig.mode =
"per-step"` path). ADR 0012 shipped an end-of-session aligned-verdict gate: the
kernel refuses `endSession()` unless the adjudicator has issued an `aligned`
verdict.

Two gaps remain:

1. There is no enforcement that the adjudicator was ever invoked in the first place.
   The `_latestVerdict === undefined` case falls through into the ADR 0012 check
   with the error code `E_NO_ALIGNED_VERDICT` — which is accurate but does not
   distinguish "adjudicator was called and rejected" from "adjudicator was never
   called at all."
2. ForgeCode's biggest single win for non-Anthropic models is a hard refusal to
   mark `task_complete` until the Adjudicator has issued any verdict in the current
   session. emerge's ADR 0032 mode can be set to `"off"`, bypassing all of this.

The leaderboard-absorption-2026-04.md plan (proposal 2) calls for a session-scoped
gate that checks whether any verdict was issued, not just the verdict kind.

## Decision

Extend `VerificationConfig` with an optional `requireVerdictBeforeExit` flag:

```ts
export interface VerificationConfig {
  readonly mode: "off" | "per-step" | "on-failure";
  readonly verifier?: AgentId;
  readonly timeoutMs?: number;
  /** ADR 0035: when true, endSession() refuses to complete unless at least one
   *  verdict was issued by the Adjudicator in this session. Default: false. */
  readonly requireVerdictBeforeExit?: boolean;
}
```

When `requireVerdictBeforeExit` is `true`, `endSession()` checks `_latestVerdict`
before the existing ADR 0012 aligned-kind check:

```
if (requireVerdictBeforeExit && _latestVerdict === undefined) {
  return { ok: false, error: { code: "E_NO_VERIFICATION_CALLED", message: ... } }
}
// then the existing aligned-kind check (E_NO_ALIGNED_VERDICT)
```

### Interaction with existing gates

Both the new gate and the ADR 0012 gate can be active simultaneously:

| `_latestVerdict` | `requireVerdictBeforeExit` | Result |
|---|---|---|
| `undefined` | `true` | `E_NO_VERIFICATION_CALLED` (new gate fires first) |
| `undefined` | `false` / unset | `E_NO_ALIGNED_VERDICT` (ADR 0012 gate) |
| `off-track` | `true` | `E_NO_ALIGNED_VERDICT` (new gate passes; kind gate fires) |
| `aligned` | `true` | `ok` |
| any | any | both bypass when `trustMode: "implicit"` |

### Back-compatibility

`requireVerdictBeforeExit` defaults to `false` (absent). Existing callers that do
not set it see no behaviour change — the ADR 0012 gate is still the only gate.

### Remediation message

The `E_NO_VERIFICATION_CALLED` error message names the adjudicator id so operators
know which agent to route verdict requests to:

```
"the Adjudicator at id=<adjudicatorId> never issued a verdict for this session —
 call request_verification or set requireVerdictBeforeExit=false to bypass."
```

## Alternatives considered

- **Always-on gate (no flag)** — Always enforce that a verdict was called.
  Rejected: breaks existing callers who use `verification.mode = "off"` or who
  rely on `trustMode: "implicit"`. The opt-in flag preserves back-compat.
- **Separate `KernelDeps.requireVerdictBeforeExit` field** — Not on
  `VerificationConfig`. Rejected: `requireVerdictBeforeExit` is conceptually part
  of the verification configuration, not a top-level kernel dep.
- **Counter instead of boolean** — Require N verifications, not just one.
  Rejected: over-engineering for no known use-case; can be added later when evidence
  surfaces.

## Consequences

- Operators who want to guarantee that the Adjudicator was consulted before session
  exit can set `requireVerdictBeforeExit: true`. This is the ForgeCode-equivalent
  enforcement point.
- The new error code (`E_NO_VERIFICATION_CALLED`) is distinct from `E_NO_ALIGNED_VERDICT`,
  making it easier to diagnose misconfigured deployments where verification was
  simply never wired up vs. wired up but returning the wrong verdict.
- `_latestVerdict` (the existing field on `Kernel`) is the signal — no new state is
  introduced.
- The check is skipped entirely when `trustMode: "implicit"`, so demo / local
  sessions are unaffected.
