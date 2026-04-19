# M4 Real-Model Validation Report

**Date:** 2026-04-19
**Status:** PASS — 3/3 tracks completed end-to-end against real model
**Note:** DO NOT submit to any public leaderboard. Local validation only.
**Companions:** `M4-PREP-SELF-TEST-REPORT.md`, `M4-REAL-PROVIDER-REPORT.md`

---

## Summary

Pre-publish validation of `emerge` against `gpt-5.4` via the user's
OpenAI-compatible gateway (`https://gmn.chuangzuoli.com/v1`). Three
tracks chosen to exercise the highest-friction surfaces likely to
surface bugs that mock-driven testing cannot find.

**Result: all three tracks PASS, one new bug found and fixed.**

| Track | Demo | Result |
|---|---|---|
| A | `examples/tbench-real-docker/` — real model + HarborSandbox (Docker) | **PASS** |
| B | `examples/tbench-real-replay/` — real model + record/replay round-trip | **PASS** |
| C | `examples/tbench-real-multi/` — real model + 3 bugs across 2 files | **PASS** |

---

## Bug found and fixed during validation

### Adjudicator-in-flight race in `stopAdjudicatorWatch`

**Symptom:** sporadic `E_NO_ALIGNED_VERDICT` from `kernel.endSession()`
even though acceptance was clearly aligned. The adjudicator's
`evaluate()` (which runs `runAcceptance`, taking 100-500ms for pytest
or 5-15s for Docker pytest) is async. Calling `stopAdjudicatorWatch()`
synchronously and then `endSession()` immediately raced: the verdict
envelope was still in-flight when endSession read `_latestVerdict`.

**Initial subagent fix attempt (reverted):** added a 10-second poll
loop in `Kernel.endSession` waiting for any verdict. **This broke 4
existing tests** (vitest 5s default timeout) because tests that mount
an adjudicator without ever firing one now waited 10s.

**Real fix:** made `stopAdjudicatorWatch` truly async — it now tracks
in-flight `evaluate()+verdict-send` promises and AWAITS them before
returning. Demos changed from `session.stopAdjudicatorWatch()` to
`await session.stopAdjudicatorWatch()`. The wait is bounded by the
adjudicator's own work; tests without verdicts return instantly.

Files: `packages/agents/src/roles/adjudicator.ts`,
`packages/eval-terminal-bench/src/session-builder.ts`, all 8 demo
callers updated.

---

## Track A — Real model + Docker

**Demo:** `examples/tbench-real-docker/` (mirrors `tbench-smoke-docker`,
fixes `reverse_string()` bug). Agent's bash tool calls execute inside
a `python:3.12-slim` container via HarborSandbox.

**Result: PASS.** Final console excerpt:
```
Verdict: aligned
2 passed, 1 warning in 0.01s
Bug fixed (file diff check): YES
=== FINAL RESULT: PASS ===
  - Bug fixed in src/strings.py (file content check)
  - Acceptance command exited 0 (pytest passed)
  - Kernel verdict gate: adjudicator confirmed aligned verdict
  - Agent's bash tool calls executed inside Docker container
```

This validates the most complex sandbox path (real provider + Docker
container + bind-mounted workspace + acceptance gate) end-to-end.

---

## Track B — Real model + replay

**Demo:** `examples/tbench-real-replay/`. Two phases:
1. **Phase 1 (record):** real provider runs the `add()` bug task,
   records a `SessionRecord` JSONL via `makeRecorder({ filePath })`.
2. **Phase 2 (replay):** loads the record, constructs a kernel with
   `reproducibility: "record-replay"` + `RecordedProvider`, replays
   the same agent loop. Asserts ZERO real provider calls in Phase 2
   AND that the file side-effects (bug fix) are reproduced.

**Result: PASS.** Final console excerpt:
```
=== Round-trip Evidence ===
Phase 1 provider calls (real): 7
Phase 2 provider calls (real): 0 (RecordedProvider intercepted all invoke() calls)
Phase 2 file side-effects: replayed correctly (bug fixed again)
Phase 2 cost: $0.000000

=== FINAL RESULT: PASS ===
  - Phase 1: real model ran, fixed bug, adjudicator aligned
  - Phase 1: SessionRecord captured (7 provider_call events)
  - Phase 2: RecordedProvider replayed without real API calls
  - Phase 2: same file-write side-effects reproduced (bug fixed again)
  - Phase 2: acceptance command passed
  - cost.totals.grand = $0.000000 during Phase 2 replay

Record-replay reproducibility tier validated.
```

**This is the most strategically important pass of the three.**
Reproducibility is one of the four named differentiators in the
project's dual thesis (auditable + reproducible + self-hostable +
composable). Before this validation, the claim was contract-with-no-impl
for real providers — only mock-driven tests covered it. Now we have
verified evidence the claim holds for real model traces.

---

## Track C — Real model + multi-step task

**Demo:** `examples/tbench-real-multi/`. Inline task with 3 distinct
bugs across 2 files, 4 pytest tests. Model must read both files,
identify each bug, write fixes, verify with pytest.

**Result: PASS.** Final console excerpt:
```
4 passed, 1 warning in 0.01s
=== FINAL RESULT: PASS ===
Bugs fixed: 3/3
  - All 3 bugs fixed across 2 files
  - Acceptance command exited 0 (pytest passed)
  - Kernel verdict gate: adjudicator confirmed aligned verdict
```

The model successfully chained: read file 1 → read file 2 → write
fix 1 → write fix 2 → verify → end. This validates that the
sessionMode permission bypass + tool-call history adapter + sanitization
all work for non-trivial multi-step reasoning.

---

## Test suite

```
$ pnpm test
Test Files  42 passed (42)
Tests  505 passed | 4 skipped (509)
```

No regressions from the bug fix. The 4 vitest tests broken by the
subagent's first-attempt 10-second poll fix were green again after
switching to the async-stopAdjudicatorWatch approach.

---

## Cost estimate

Approximate API spend across all three tracks (multiple test runs,
debugging iterations): **< $0.50 total**. Each successful run
is sub-cent at the user's gateway pricing for `gpt-5.4`.

---

## Are we ready to publish v0.1 to npm?

**Yes, with caveats.** The harness now has demonstrated end-to-end
real-model success across three independent surfaces (Docker sandbox,
replay reproducibility, multi-step reasoning), plus the existing
mock-driven test suite of 505 tests.

The strongest "no" if we are NOT ready: **we still have only one
real model tested (`gpt-5.4`) on one custom OpenAI-compatible gateway**.
We have not exercised the harness against:
- Anthropic (via the `@lwrf42/emerge-provider-anthropic` package shipped at M1)
- Direct OpenAI (`api.openai.com/v1`)
- A locally-hosted model (Ollama, vLLM, llama.cpp)
- A different reasoning level (only `medium` was tested in this PR)

If the goal is "v0.1 with honest README — works against any
OpenAI-compatible endpoint AND Anthropic," at least one Anthropic
real run should be added to validation. If the goal is narrower —
"v0.1 with honest README — verified against custom OpenAI-compatible
gateway, others should work but unverified" — we are ready now.

User decides: publish at the narrower scope OR add 1-2 more provider
runs first.

---

## Files added / modified

**New demos:**
- `examples/tbench-real-docker/` (package + src + tsconfig)
- `examples/tbench-real-replay/` (package + src + tsconfig)
- `examples/tbench-real-multi/` (package + src + tsconfig)

**Bug fixes:**
- `packages/agents/src/roles/adjudicator.ts` — `watchBus` returns
  `() => Promise<void>` that awaits in-flight evaluations
- `packages/eval-terminal-bench/src/session-builder.ts` — type
  signature update + Phase-1/Phase-2 replay support fields
  (`recorder`, `replayRecord`, `replayProviderFactory`)

**Caller updates (all changed `stop` to `await stop`):**
- `examples/tbench-real-multi/src/index.ts`
- `examples/tbench-real-docker/src/index.ts`
- `examples/tbench-real-replay/src/index.ts`
- `examples/tbench-real-inline/src/index.ts`
- `examples/tbench-smoke-docker/src/index.ts`
- `examples/tbench-smoke-inline/src/index.ts`
- `examples/topology-supervisor-worker/src/index.ts`
- `packages/eval-terminal-bench/src/cli.ts`
