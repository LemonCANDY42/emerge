# VERIFICATION.md

Summary of what has and has not been verified end-to-end for `emerge` v0.1.0.

## Mock-driven test suite

- **505 tests passing, 4 skipped** (509 total) across 42 test files
- **38 ADRs** documenting design decisions
- Run with: `pnpm test`
- Evidence: `M4-REAL-VALIDATION-REPORT.md`, `M4-PREP-SELF-TEST-REPORT.md`

## Real-model end-to-end verification

**Model:** `gpt-5.4`
**Endpoint:** OpenAI-compatible gateway (`https://gmn.chuangzuoli.com/v1`)
**Date:** 2026-04-19

### Verified

| Surface | Demo | Result | Evidence |
|---|---|---|---|
| Real model + inproc sandbox | `examples/tbench-real-inline/` | PASS | `M4-REAL-VALIDATION-REPORT.md` |
| Real model + Docker sandbox | `examples/tbench-real-docker/` | PASS | `M4-REAL-VALIDATION-REPORT.md` Track A |
| Real model + record/replay round-trip | `examples/tbench-real-replay/` | PASS | `M4-REAL-VALIDATION-REPORT.md` Track B |
| Real model + multi-step task (3 bugs, 2 files) | `examples/tbench-real-multi/` | PASS | `M4-REAL-VALIDATION-REPORT.md` Track C |
| Replay reproducibility (Phase 2: 0 real API calls, file side-effects reproduced) | `examples/tbench-real-replay/` | VERIFIED | `M4-REAL-VALIDATION-REPORT.md` Track B |
| Surveillance hint loop | `examples/topology-supervisor-worker/` | VERIFIED | `M4-PREP-SELF-TEST-REPORT.md` |
| Custodian + Adjudicator + Postmortem auto-loop | `examples/topology-supervisor-worker/` | VERIFIED | `M4-PREP-SELF-TEST-REPORT.md` |
| TUI live + replay (Ink testing-library) | `packages/tui/src/*.test.ts` | VERIFIED | vitest suite |
| Dashboard server-side + client-side (jsdom) | `packages/dashboard/vitest.config.ts` | VERIFIED | vitest suite |
| Adjudicator async-stopAdjudicatorWatch fix | all 8 demo callers | VERIFIED | regression suite green |

### Shipped but not yet verified with real model

The following paths compile, pass all mock-driven tests, and have correct adapters, but have not been exercised against a live API endpoint:

| Provider / path | Package | Notes |
|---|---|---|
| Anthropic Claude (via `api.anthropic.com`) | `@emerge/provider-anthropic` | Adapter ships; needs real `ANTHROPIC_API_KEY` run |
| Direct OpenAI (`api.openai.com/v1`) | `@emerge/provider-openai` | Verified via compat gateway; direct endpoint untested |
| Ollama (local) | `@emerge/provider-openai-compat` | Architecture identical to verified gateway path |
| vLLM | `@emerge/provider-openai-compat` | Architecture identical to verified gateway path |
| llama.cpp | `@emerge/provider-openai-compat` | Architecture identical to verified gateway path |

### Reasoning levels

Only `medium` reasoning level was tested in real-model validation. `low` and `high` reasoning levels are shipped and expected to work but not explicitly verified.

## Cost estimate

Total real API spend across all three tracks (including debugging iterations): < $0.50 USD at gateway pricing for `gpt-5.4`.

## Reproducing

```bash
# Mock-driven test suite
pnpm test

# Real-model: requires EMERGE_LLM_BASE_URL + EMERGE_LLM_MODEL + EMERGE_LLM_API_KEY
node examples/tbench-real-inline/dist/index.js
node examples/tbench-real-docker/dist/index.js   # requires Docker
node examples/tbench-real-replay/dist/index.js
node examples/tbench-real-multi/dist/index.js
```

All real-model demos skip cleanly (exit 0) when env vars are unset — safe in CI.
