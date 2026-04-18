# ADR 0034 — Pre-dispatch tool-call correction layer

**Status:** accepted
**Date:** 2026-04-18

## Context

ForgeCode (Terminal-Bench rank 2-3) attributes consistent cross-model performance to
fixing common LLM tool-call errors before dispatch — turning would-be tool errors
into silent fixes. The M3b absorption plan (leaderboard-absorption-2026-04.md)
identified this as proposal 1: medium cost, high impact, M3c2 slot.

The symptom is well-known: language models occasionally emit tool call inputs with
type mismatches (`"42"` instead of `42`), missing optional fields that have JSON
Schema defaults, or nested objects serialised as JSON strings inside a string field.
Under emerge's current path these arrive at `tool.invoke()` exactly as emitted and
cause avoidable validation errors that consume a full turn.

The kernel already validates tool specs at registration time (ADR 0005). What is
missing is a lightweight runtime correction pass between model output and dispatch.

## Decision

Add a pure, framework-agnostic function `correctToolCall` in
`packages/kernel/src/runtime/correction.ts`. The function signature is:

```ts
function correctToolCall(
  call: ToolInvocation,
  jsonSchema: unknown,
): { call: ToolInvocation; fixes: readonly Fix[] }
```

A `Fix` is:

```ts
interface Fix {
  readonly kind: "type-coerce" | "default-fill" | "string-unescape" | "string-parse-json";
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}
```

### Heuristics (start small; add only when evidence supports)

| Kind | Trigger | Action | Guard |
|---|---|---|---|
| `type-coerce` | spec says `number`, value is a string | `Number(value)` | Only when `String(Number(value)) === value` (round-trip safe) |
| `type-coerce` | spec says `boolean`, value is a string | `"true"` → `true`, `"false"` → `false` | Case-insensitive; only the two canonical forms |
| `default-fill` | field is absent, spec has `default` | fill with default value | Never overwrites a present field |
| `string-unescape` | spec says `object`/`array`, value is a string | `JSON.parse(value)` | Only when parsed result matches expected type; leaves unchanged on parse error or type mismatch |

### Wiring

In `agent-runner.ts`, between building the `ToolInvocation` and calling
`sandbox.run(..., () => tool.invoke(invocation))`, apply:

```ts
const { call: invocation, fixes } = correctToolCall(baseInvocation, tool.spec.jsonSchema);
if (fixes.length > 0 && this.deps.telemetry) {
  telemetry.event(corrSpanId, "tool_call.corrected", { fixes: JSON.stringify(fixes) });
}
```

The correction layer reads `tool.spec.jsonSchema` (the raw JSON Schema declared when
the tool was registered). Tools registered without `jsonSchema` receive no correction.

### Non-corruption guarantee

`correctToolCall` never mutates its arguments. It returns the original call reference
unchanged when no fixes apply (zero allocation). If a heuristic cannot safely apply
(round-trip fails, parse error, type mismatch after parse), the field is passed
through to the existing error path unchanged — no silent corruption.

## Alternatives considered

- **Schema-validation gate before dispatch** — Validate against the full JSON Schema
  and reject immediately on failure. Rejected: this is the current behaviour; the
  correction layer sits before it, not instead of it.
- **Model-side prompt engineering** — Instruct the model to emit correct types.
  Rejected: reduces engineering budget for other improvements; heuristic correction
  is cheaper and model-agnostic.
- **Full schema-aware coercion library** — Use a JSON Schema coercion library.
  Rejected: pulls a heavyweight dependency into the kernel hot path; the heuristics
  above cover 90%+ of observed failures at negligible cost.
- **Apply correction to all input regardless of jsonSchema** — Rejected: without a
  schema we cannot know the intended type; guessing introduces silent corruption risk.

## Consequences

- Common LLM type errors are silently fixed before dispatch; the model never sees
  the error and the turn is not wasted.
- Fixes are observable via telemetry (`tool_call.corrected` event) — not hidden.
- Tools registered without `jsonSchema` are unaffected; the correction layer is a
  no-op for them.
- Adding new heuristics requires evidence (observed failure mode) and a round-trip
  safety argument; speculative heuristics are not added.
- The `FixKind` union is extensible; `"string-parse-json"` is reserved for a
  variant of `string-unescape` that uses `JSON.parse` on fields typed as `string`
  but where the value appears to be double-encoded JSON (future heuristic).
