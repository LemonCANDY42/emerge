# ADR 0036 — Marker-based early command completion

**Status:** deferred — no code in this PR
**Date:** 2026-04-18
**Reference:** leaderboard-absorption-2026-04.md line 161 · KIRA reference impl

## Problem

Terminal-Bench 2.0 scores on a time-based metric: tasks completed faster score
higher. The Terminus-KIRA agent (rank 10, open source) recovers wall-clock time by
short-circuiting the wait for long-running shell commands as soon as they finish,
rather than waiting for a fixed polling interval or a global timeout.

KIRA's approach:

1. Append an echo sentinel after each command:
   `<user-command> ; echo __CMDEND__<seq>__`
2. Poll the tmux pane every 500 ms, scan output for the sentinel.
3. Exit the poll loop as soon as the sentinel is seen.
4. Strip the sentinel from the output before passing it to the LLM.

This is a direct wall-clock recovery for any task where the command completes
substantially before the polling interval or the per-command timeout would fire.

KRAFTON's blog reports this gave measurable score improvement on TB 2.0 tasks that
involve compilation, test runs, and build steps — all of which complete in seconds
but are polled at fixed intervals in naive implementations.

## Why this is deferred

The current emerge `bash` tool (`packages/tools/src/index.ts`) uses Node.js
`execAsync` (from `util.promisify(exec)`). Under `execAsync`:

- The underlying process exits, the child-process event loop drains, and the
  Promise resolves — all in one synchronous-from-the-caller's-perspective await.
- There is no polling loop to short-circuit. The implementation already exits as
  soon as the process exits; adding a sentinel adds overhead for zero benefit.

The marker-based pattern from KIRA only adds value over a **persistent shell**
(tmux / spawn-and-keep-open) where the caller deliberately does not wait for process
exit and instead polls for output. emerge does not ship a persistent-shell primitive.

A persistent shell would look like:

```ts
// hypothetical — not in this codebase
const shell = await sandbox.openShell();         // spawns a persistent process
const result = await shell.run(cmd, { marker }); // polls until marker appears
await shell.close();
```

This design is load-bearing for Terminal-Bench 2.0 tasks that require:
- Running a server in the background while verifying it is healthy
- Starting a long compilation and monitoring progress
- Running tests with streaming output

None of these are currently achievable with the single-invocation `bash` tool.

## Deferred trigger

Implement ADR 0036 when:

1. `@emerge/sandbox-harbor` lands — the planned M4-prep sandboxing package that
   wraps persistent shell / Docker primitives. That package is the natural home for
   a persistent shell tool and the sentinel-polling logic.
2. The `bash` tool is replaced or supplemented with a spawn-and-monitor variant.

At that point, the implementation is straightforward:

- The persistent-shell tool appends ` ; echo __CMDEND__<seq>__` before running.
- The read loop in the shell driver exits on sentinel match.
- The sentinel is stripped from `stdout` before returning to the LLM.
- `seq` is a monotonically incrementing counter scoped to the shell session to
  prevent false matches from prior commands whose output was buffered.

## Consequences of deferral

- No wall-clock recovery for long-running commands in the current codebase.
- Existing TB 2.0 scores under the current `execAsync` model are unaffected (the
  command timeout is the ceiling, which is already configurable).
- When `@emerge/sandbox-harbor` lands, this ADR is the implementation brief.
  Estimated cost at that point: small (sentinel injection + poll-exit + strip).

## Reference implementation

See [github.com/krafton-ai/KIRA](https://github.com/krafton-ai/KIRA/blob/main/terminus_kira/terminus_kira.py)
for the tmux-polling reference. The sentinel pattern is directly extractable from
the `execute_commands` implementation in that file.
