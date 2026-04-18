# Terminal-Bench Integration Plan

**Status:** draft
**Date:** 2026-04-17
**Authors:** emerge team

---

## 1. Background

[Terminal-Bench](https://terminal-bench.com) is a leaderboard that measures how
well coding agents handle realistic shell-based software-engineering tasks. Each
task presents the agent with a repository and a goal (fix a bug, add a feature,
pass a test suite). Evaluation is fully automated: the harness checks out the
commit the agent produces and runs the task's acceptance tests.

Emerge already has:

- A kernel with surveillance, cycle guards, and quota management.
- `@emerge/tools` with file-system tools (`makeFsReadTool`, `makeFsWriteTool`).
- `@emerge/tools-mcp` for bridging MCP-compatible tool servers.
- `CalibratedSurveillance.runProbesAsync()` for real per-provider capability
  measurement.
- A `SchemaAdapter` layer for per-provider JSON Schema normalization.
- Session replay (`@emerge/replay`) for debugging failed runs.

What is missing is a **task harness**: the glue between a Terminal-Bench task
definition and an emerge session.

---

## 2. Goals

1. Run any Terminal-Bench task against any mounted provider without manual
   scaffolding.
2. Produce a session artifact that can be replayed and audited.
3. Support parallel task execution (one emerge session per task slot).
4. Measure actual provider capabilities via `runProbesAsync` before task
   assignment, not just claimed context window.
5. Gate task completion on the acceptance test suite (ADR 0012 adjudicator
   pattern).

---

## 3. Architecture

### 3.1 Package structure

```
packages/
  bench-runner/         # @emerge/bench-runner (new)
    src/
      task-loader.ts    # parse Terminal-Bench task YAML / JSON spec
      session-builder.ts # wire task into an emerge session
      acceptance-runner.ts # execute acceptance tests, emit verdict
      index.ts
```

### 3.2 Task spec ingestion

Terminal-Bench tasks ship as YAML (or JSON). A `TaskSpec` type mirrors the
relevant fields:

```ts
interface TaskSpec {
  id: string;
  title: string;
  repoUrl: string;
  baseCommit: string;
  goal: string;
  acceptanceCommand: string; // e.g. "pytest tests/acceptance/"
  timeoutSeconds: number;
  difficulty: "trivial" | "small" | "medium" | "large" | "research";
}
```

`task-loader.ts` reads the spec, clones the repo into an isolated workspace
(`@emerge/workspaces-git-worktree` is the right primitive here), and resolves
the base commit.

### 3.3 Session wiring

`session-builder.ts` constructs an emerge session:

1. **Provider selection** — `runProbesAsync` determines the observed capability
   ceiling for each candidate provider. Tasks whose `difficulty` exceeds the
   ceiling are routed to a stronger model or decomposed (surveillance handles
   this automatically).
2. **Tool set** — `makeFsReadTool` and `makeFsWriteTool` mounted on the task's
   workspace root. Shell execution via an MCP stdio server (`mcpServer:stdio`,
   e.g. `bash-mcp`).
3. **Schema adapters** — `kernel.mountSchemaAdapter` called with the correct
   adapter for the selected provider.
4. **Truncation** — `maybeApplyTruncationNotice` is already wired in the agent
   runner; large file reads surface truncation notices automatically.
5. **Verification** — `VerificationConfig { mode: "per-step", verifierId }`
   optional for debugging; omit for leaderboard runs to avoid latency overhead.
6. **Session start** — `kernel.startSession({ goal: task.goal, ... })`.

### 3.4 Acceptance gating

`acceptance-runner.ts` is registered as the Adjudicator (`AgentId("adjudicator")`):

- On `endSession` bus signal, run `task.acceptanceCommand` in the workspace.
- Exit code 0 → verdict `aligned`; non-zero → verdict `failed` with stdout/stderr.
- The adjudicator writes its verdict back via the `verdictEnvelope` bus message
  as specified in ADR 0012.

### 3.5 Parallelism

Each task runs in its own kernel instance with an isolated workspace (git
worktree). Task slots map 1:1 to OS processes via a thin orchestrator script:

```
bench-runner/
  src/
    orchestrator.ts   # spawns N worker processes, collects results
    worker.ts         # single-task entry point (invoked as child process)
```

The orchestrator collects per-task verdicts and emits a JSON leaderboard
summary.

---

## 4. Data flow

```
Terminal-Bench task YAML
         │
         ▼
    task-loader.ts
    (clone repo, parse spec)
         │
         ▼
    session-builder.ts
    ┌────────────────────────────┐
    │  runProbesAsync → ceiling  │
    │  mountSchemaAdapter        │
    │  mount tools (fs + shell)  │
    │  startSession              │
    └────────────────────────────┘
         │
         ▼
    AgentRunner loop
    (perceive → decide → act → observe)
         │
         ▼
    acceptance-runner.ts (adjudicator)
    runs acceptanceCommand
         │
         ├─ exit 0  → verdict: aligned  → leaderboard PASS
         └─ exit !0 → verdict: failed   → leaderboard FAIL
```

---

## 5. Key design decisions

### 5.1 One kernel per task, not one global kernel

Isolation is non-negotiable for parallel runs. A shared kernel would
require thread-safe bus routing, shared quota ledgers, and cross-task
interference management. The cost outweighs any benefit.

### 5.2 Shell tool via MCP, not a first-class emerge tool

`bash-mcp` (a reference MCP server for shell execution) is a natural fit for
`@emerge/tools-mcp`. This keeps `@emerge/tools` free of shell-execution
concerns and lets the bench runner swap in a sandboxed shell server without
changing tool definitions.

### 5.3 Surveillance ceiling drives provider routing

Rather than hard-coding "use GPT-4 for hard tasks", the harness probes each
candidate provider before task assignment. This makes the leaderboard results
meaningful: we measure actual capability, not assumed capability.

### 5.4 Session replay for post-mortem analysis

Failed tasks should be debugged from the session artifact, not from logs.
`@emerge/replay` can replay the session with a different provider or modified
tools to root-cause failures without re-running the task from scratch.

---

## 6. Milestones

| Milestone | Description | Depends on |
|---|---|---|
| M4a | `task-loader.ts` + `session-builder.ts` (no acceptance gating) | M3b |
| M4b | `acceptance-runner.ts` adjudicator integration | M4a, ADR 0012 |
| M4c | Orchestrator + parallel slot management | M4b |
| M4d | Leaderboard submission tooling | M4c |
| M4e | `runProbesAsync`-driven provider routing | M4a, runProbesAsync (M3b) |

---

## 7. Open questions

1. **Sandboxed shell execution** — Terminal-Bench tasks may require package
   managers (`pip install`, `npm install`). Should the bench runner use Docker
   for full isolation, or is a restricted `bash-mcp` with a blocklist
   sufficient for the early leaderboard runs?

2. **Multi-agent decomposition on the leaderboard** — Large/research tasks may
   benefit from a supervisor-worker topology. Does the leaderboard score the
   combined result or penalize token cost? Token cost tracking (ADR 0022) is
   already available.

3. **Task spec versioning** — Terminal-Bench tasks evolve. The `task-loader.ts`
   should version-pin the task spec hash used for a run so that results are
   reproducible via `@emerge/replay`.

4. **Rate limits during probing** — `runProbesAsync` fires 15 provider calls
   per probe set. For high-parallelism runs this may hit rate limits. Consider
   caching probe results per provider per session batch.
