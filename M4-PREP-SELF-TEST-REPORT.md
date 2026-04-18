# M4-Prep Self-Test Report

**Date:** 2026-04-18
**Status:** PASS — both smoke tasks completed successfully
**Note:** DO NOT submit to any public leaderboard. This report covers local validation only.

---

## Setup

- Platform: macOS Darwin 25.4.0 (arm64)
- Node: v22+ / pnpm workspaces
- Docker Desktop: available (for Task B)
- Test suite baseline: 383 tests passed, 3 skipped (Docker-gated unit tests)

---

## Task A — `tbench-smoke-inline` (InProcSandbox, no Docker)

**Task:** Fix the broken `add()` function in `src/util.py`
**Bug:** `return a - b` instead of `return a + b`
**Sandbox:** InProcSandbox (filesystem access, no container)
**Provider:** MockProvider (4-step scripted sequence)
**Acceptance:** `python3 -m pytest tests/ -x -q`

### Mock provider steps

| Step | Action | Tool |
|------|--------|------|
| 1 | Read `src/util.py` to see the bug | `fs.read` |
| 2 | Write fixed content (a + b) | `fs.write` |
| 3 | Run pytest to verify | `bash` |
| 4 | End turn | — |

### Console output

```
=== tbench-smoke-inline — Task A self-test ===

Task: Fix the broken add() function in src/util.py
Acceptance: python3 -m pytest tests/ -x -q
Sandbox: inproc (no Docker required)

Workspace: /var/folders/c8/42b2xypx11x0d77nv7sw7pjm0000gn/T/.emerge-workspaces/ws-1776534980271-1-JmeNkZ
Bug present before run: YES (expected)

Session: tbench-smoke-inline-add-bug-1776534980273
Agent spawned: tbench-agent
Running agent loop...


Agent loop complete:
  State: completed
  Tokens in: 980
  Tokens out: 180
  Wall time: 353ms

Running acceptance command: python3 -m pytest tests/ -x -q

=== Acceptance Result ===
  Exit code: 0
  Duration: 335ms
  Verdict: aligned
  stdout:
..                                                                       [100%]
=============================== warnings summary ===============================
tests/test_util.py::test_add
  /opt/homebrew/lib/python3.14/site-packages/pytest_asyncio/plugin.py:1186: DeprecationWarning: 'asyncio.get_event_loop_policy' is deprecated and slated for removal in Python 3.16
    return asyncio.get_event_loop_policy()

-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
2 passed, 1 warning in 0.01s


Bug fixed: YES

Session cost: $0.010000

=== FINAL RESULT: PASS ===

All assertions passed. Task A smoke test complete.
```

### Result

| Metric | Value |
|--------|-------|
| Verdict | **aligned** |
| Wall time | 353 ms |
| Acceptance exit code | 0 |
| Tokens in / out | 980 / 180 |
| Session cost (mock) | $0.010000 |
| Bug fixed | YES |

---

## Task B — `tbench-smoke-docker` (HarborSandbox, Docker)

**Task:** Fix the broken `reverse_string()` function in `src/strings.py`
**Bug:** `return s` instead of `return s[::-1]`
**Sandbox:** HarborSandbox (`python:3.12-slim`)
**Provider:** MockProvider (4-step scripted sequence)
**Acceptance:** `docker run ... python:3.12-slim sh -c "pip install -q pytest && python3 -m pytest tests/ -x -q"`

### Mock provider steps

| Step | Action | Tool |
|------|--------|------|
| 1 | Read `src/strings.py` to see the bug | `fs.read` |
| 2 | Write fixed content (`s[::-1]`) | `fs.write` |
| 3 | Install pytest and run it inside Docker | `bash` |
| 4 | End turn | — |

**Note on bash step:** `python:3.12-slim` does not ship with pytest. The bash
tool invokes `pip install -q pytest && python3 -m pytest tests/ -x -q` inside
the Harbor container. This adds ~10 seconds of cold-install time on first run
(subsequent runs with a warm pip cache are faster). The acceptance command
mirrors this pattern.

### Console output

```
=== tbench-smoke-docker — Task B self-test ===

Task: Fix the broken reverse_string() function in src/strings.py
Acceptance: python3 -m pytest tests/ -x -q
Sandbox: HarborSandbox (Docker image: python:3.12-slim)

Checking Docker availability...
  Docker is available.

Pulling Docker image: python:3.12-slim
  Pulling image python:3.12-slim (may take a moment)...
  Image ready (3575ms)

Materializing workspace...
  Workspace: /var/folders/c8/42b2xypx11x0d77nv7sw7pjm0000gn/T/.emerge-workspaces/ws-1776534939901-1-gzivYd
  Bug present before run: YES (expected)

Session: tbench-smoke-docker-string-bug-1776534939908
Agent spawned: tbench-agent
Running agent loop (bash tool calls go to Docker)...

Agent loop complete:
  State: completed
  Tokens in: 1080
  Tokens out: 180
  Wall time: 11152ms

Running acceptance command (inside Docker): python3 -m pytest tests/ -x -q

=== Acceptance Result ===
  Command: docker run --rm -v /var/folders/c8/.../ws-1776534939901-1-gzivYd:/workspace -w /workspace python:3.12-slim sh -c "pip install -q pytest && python3 -m pytest tests/ -x -q"
  Exit code: 0
  Duration: 14764ms
  Verdict: aligned
  stdout:
..                                                                       [100%]
2 passed in 0.06s

  stderr:
WARNING: Running pip as the 'root' user can result in broken permissions ...

Bug fixed: YES

Session cost: $0.010000

=== FINAL RESULT: PASS ===

All assertions passed. Task B Docker smoke test complete.
```

### Result

| Metric | Value |
|--------|-------|
| Verdict | **aligned** |
| Wall time (agent) | 11,152 ms |
| Acceptance exit code | 0 |
| Acceptance duration | 14,764 ms |
| Tokens in / out | 1080 / 180 |
| Session cost (mock) | $0.010000 |
| Bug fixed | YES |

---

## Test Suite Baseline

```
pnpm test
 Test Files  38 passed (38)
      Tests  383 passed | 3 skipped (386)
   Duration  4.47s
```

The 3 skipped tests are Docker-gated unit tests in `packages/sandbox-harbor/src/index.test.ts`
(gated on `HAS_DOCKER=1`). They were run separately and verified against the live Docker daemon
as part of Task B validation.

---

## Issues Found and Resolved

### 1. `fs.write` and `bash` tools blocked by `defaultMode: "ask"`

**Root cause:** The agent-runner checks `tool.spec.permission.defaultMode` before calling
`sandbox.run()`. Tools with `defaultMode: "ask"` emit a `human.request` bus message and wait
60 seconds for a `human.reply`. In automated eval runs, no reply arrives and the tool call is
denied after the timeout.

**Fix:** `session-builder.ts` wraps every registered tool with `withAutoPermission()`, which
overrides `defaultMode` to `"auto"`. The sandbox policy (`InProcSandbox` or `HarborSandbox`)
remains the real authorization gate. This is the correct separation: the tool's default mode
applies to interactive (human-in-the-loop) sessions; eval sessions need autonomous operation.

### 2. `python:3.12-slim` lacks pytest

**Root cause:** The official `python:3.12-slim` image does not include pytest.

**Fix:** The bash verification step and Docker acceptance command both prepend
`pip install -q pytest &&`. This adds ~10–15 seconds on first container start but is
correct for isolated eval containers.

---

## Architecture Notes for M4 Public Submission

Before submitting to any public leaderboard, the following should be addressed:

1. **Real provider integration:** The smoke tests use `MockProvider`. A real run requires
   `AnthropicProvider` or `OpenAIProvider` with valid API keys. The blueprint system supports
   this via `provider` parameter injection.

2. **Task discovery:** `loadTask()` reads a single YAML file. A benchmark runner needs to
   enumerate tasks from a directory or manifest and run them in parallel.

3. **Result persistence:** Verdicts are currently printed to stdout. A runner should write
   structured JSON results (task id, verdict, duration, token usage, cost) to a report file.

4. **Container reuse:** Each `HarborSandbox` bash call starts a fresh container (cold start
   ~10s). Consider a long-running container per task session for multi-step tasks.

5. **pip cache warming:** Pre-installing pytest into the Docker image (or using a custom image)
   eliminates the 10-15 second pip install overhead per acceptance run.

---

**Decision:** Both tasks pass locally. Infrastructure is validated. Proceed to M4 milestone
planning for public submission when the above items are addressed.
