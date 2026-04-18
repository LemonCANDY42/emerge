# ADR 0033 — Truncation-aware tool results

**Status:** accepted
**Date:** 2026-04-17

## Context

Tool-result projections (ADR 0030) let agent authors declare transformation
pipelines. One common transformation is capping result size to a byte limit
(`cap` step). When a result is capped the model receives a partial view but
has no way to know:

1. How much was dropped.
2. Whether a full view is accessible elsewhere (e.g. via a `read_handle` tool).

Without this signal the model may reason on an incomplete result as if it were
complete, producing subtly wrong answers. This is worse than a hard error.

The existing ad-hoc pattern — appending `...[truncated]` manually inside each
tool — is inconsistent across tools and provides no structured metadata.

## Decision

Add a `applyTruncationNotice` helper in
`packages/kernel/src/runtime/truncation.ts`:

```ts
function applyTruncationNotice(
  result: ToolResult,
  fullSize: number,
  previewSize: number,
): ToolResult;
```

The helper prepends a machine-parseable prefix to `result.preview`:

```
[TRUNCATED: showing N of M bytes. Call read_handle('handle') to read more.]
```

Where:
- `N` = `previewSize` (bytes shown to the model).
- `M` = `fullSize` (true size of the underlying data).
- `handle` = `result.handle` if present, otherwise `"n/a"`.

A convenience wrapper `maybeApplyTruncationNotice(result)` applies the notice
automatically when `result.sizeBytes > result.preview.length`. The agent runner
calls `maybeApplyTruncationNotice` on every tool result before projections run,
so truncation is detected and annotated without any per-tool effort.

The `ToolResult` contract (`packages/kernel/src/contracts/tool.ts`) already
carries `sizeBytes` and optional `handle`; no contract changes are required.

### Tool adoption

Tools that already know they are truncating should call `applyTruncationNotice`
directly for precise `fullSize` reporting. The `makeFsReadTool` in
`@emerge/tools` is the first adopter.

## Alternatives considered

- **No signal** (status quo) — Model reasons on partial data silently. Rejected:
  produces subtle errors in long-document tasks.
- **Hard error on truncation** — Return `ok: false` when result is truncated.
  Rejected: tools truncate intentionally for performance; the model should
  receive a partial answer, not an error.
- **Separate `truncated: boolean` field on `ToolResult`** — Structured flag
  without the notice text. Rejected: the notice text is what the model actually
  reads; a boolean that the model never sees is not useful at inference time.
- **Per-projection truncation signal** — Each `cap` step in the projection
  pipeline annotates. Rejected: projections run after this helper; separating
  the concerns keeps the pipeline simpler.

## Consequences

- Models always know when they are seeing a partial result and how to get the
  full one.
- The helper is zero-cost when no truncation occurred (`maybeApply` fast path).
- Session logs capture the notice verbatim, making audits trivial.
- Tool authors can opt out by not calling `maybeApplyTruncationNotice` and not
  setting `sizeBytes`, though this is discouraged.
