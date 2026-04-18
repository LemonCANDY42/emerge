# ADR 0037 — JSONL event schema as a public contract

**Status:** accepted  
**Date:** 2026-04-18  
**Scope:** `packages/kernel/src/contracts/jsonl-schema.ts`, `packages/telemetry-jsonl`, `packages/replay`

---

## Problem

The recorder in `@emerge/replay` wrote raw `RecordedEvent` objects to disk in
two shapes: one JSON blob per session (the "fat record") appended at
`end()`-time, and individual span lines from `@emerge/telemetry-jsonl` in an
ad-hoc `{ type: "start" | "end" | "event", ... }` format.

Neither format was a contract. As a result:

- The CLI could not parse a JSONL file without reverse-engineering the recorder.
- The TUI and OTel exporter had no stable source of truth to build against.
- Adding a new event kind to the runtime silently broke every downstream reader.
- The telemetry-jsonl lines and the replay lines were incompatible — two tools
  for the same session produced unreadable output.

---

## Decision

Define a single, versioned JSONL event schema in
`packages/kernel/src/contracts/jsonl-schema.ts`. Every component that writes
to a JSONL stream (recorder, telemetry, CLI) MUST produce lines that conform
to this schema.

### Schema structure

Every line is a compact JSON object (no pretty-printing) with:

- `v` — schema version string, always the first key. Current: `"1.0.0"`.
- `type` — discriminant string from a closed set of known event types.
- `at` — Unix timestamp in milliseconds.
- Additional fields per event type.

The full type union is `JsonlEvent` in `jsonl-schema.ts`.

### Versioning policy

| Change | Version impact |
|---|---|
| Add a new optional field to an existing event | patch — no version bump |
| Add a new event `type` to the union | minor — no version bump |
| Remove or rename any field within a major version | **FORBIDDEN** |
| Remove or rename an event type | **major bump required** |
| Change the meaning of an existing field | **major bump required** |

Bumping the major (e.g. `"1.0.0"` → `"2.0.0"`) is the only legitimate path for
breaking changes. When bumped, update `JSONL_SCHEMA_VERSION`, open a migration
guide in `docs/cli/`, and bump it in `parseJsonlLine`'s error message.

### Parse-failure policy

`parseJsonlLine` returns `{ ok: false, error: string }` for:

1. Empty lines.
2. Invalid JSON.
3. Mismatched `v` (version). Error message cites both expected and actual version.
4. Unknown `type` discriminant.

**CLI rule:** a parse failure on any line is fatal — the command exits non-zero.  
**TUI rule:** a parse failure on a streaming line MAY be logged and skipped (the
TUI should display a "corrupted line" indicator and continue).

---

## Alternatives considered

### A. Keep the fat-record format

The recorder collected all events in memory and wrote one giant JSON blob at
session end. This means:

- A process crash loses all events for that session.
- The CLI cannot stream progress; it must wait for session end.
- Parsing requires deserialising potentially megabytes of nested JSON.

**Rejected.** Streaming per-event is strictly better for observability.

### B. Two separate schemas (replay vs. telemetry)

Keep `RecordedEvent` (replay) and span events (telemetry) as separate schemas
that the CLI joins at read time.

**Rejected.** Two schemas double the parsing surface and create ordering
ambiguity when interleaving replay and telemetry events for the same session.
A unified schema with a discriminant on `type` is simpler and greppable.

### C. JSON Schema / protobuf as the canonical form

Use a formal schema language and generate TypeScript from it.

**Rejected** for v1. The TypeScript discriminated union is already the
source of truth the compiler enforces. Formal schemas can be generated from
it later via `ts-to-zod` or similar. Adding them now is speculative complexity.

---

## Consequences

### Positive

- Every downstream tool (CLI, TUI, OTel exporter, VS Code extension) builds
  against one stable contract.
- Adding an event kind only requires adding a member to the `JsonlEvent` union
  and a case in `fromRecordedEvent`. The compiler enforces exhaustiveness.
- The per-event streaming write means a crashed session still has useful data
  up to the crash point.
- `parseJsonlLine` centralises version-mismatch detection; callers get a clear
  error message instead of a silent wrong parse.

### Negative / trade-offs

- The per-line format is slightly larger than the fat-record blob (each line
  carries the repeated `v` field). At typical session sizes (hundreds of
  events) this is negligible.
- Existing code that parsed the fat-record blob must be updated. There are no
  external consumers at this point; the only affected code is the demo scripts
  (all updated in M3c2).
- `parseJsonlLine` does NOT do deep field validation — it checks `v` and
  `type` only. Callers that need full field validation should layer Zod on top.

---

## Implementation notes

- `packages/replay/src/index.ts` — `makeRecorder({ filePath })` now writes:
  - A `session.start` JSONL line on `start()`.
  - One JSONL line per `record()` call (via `fromRecordedEvent`).
  - A `session.end` JSONL line on `end()`.
  - The old fat-record write is removed. The in-memory `SessionRecord` is still
    built and returned from `end()` for callers that need it in-process.
- `packages/telemetry-jsonl/src/index.ts` — `start()` / `end()` / `event()`
  now call `spanStartEvent()` / `spanEndEvent()` / `spanEventEvent()` from the
  schema contract and write the resulting `JsonlEvent` as a compact JSON line.
- Line-buffered streaming append is the design: `appendFileSync` is called once
  per event. On high-throughput sessions (thousands of events/s) callers should
  consider wrapping with a `BufferedWriter`; this is a future optimisation.
