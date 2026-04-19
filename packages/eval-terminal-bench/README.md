# @emerge/eval-terminal-bench

Terminal-Bench task runner for the emerge agent harness. Provides:

- **Task loader** — parse and materialize `TaskSpec` YAML/JSON files
- **Session builder** — wire Kernel + tools + adjudicator for eval runs
- **Blueprint** — one-call session setup with sensible defaults
- **Acceptance runner** — run acceptance commands and produce verdicts
- **CLI** — `emerge-tbench run <task.yaml>` for local task execution

v0.1.0 — early. Real-model verified against `gpt-5.4` with Docker and inproc sandboxes — see VERIFICATION.md.

## Install

```bash
npm install @emerge/eval-terminal-bench
```

Or run without installing:

```bash
npx @emerge/eval-terminal-bench run task.yaml --sandbox inproc
```

## Import

```ts
import {
  loadTask,
  materializeTask,
  runAcceptance,
  makeTerminalBenchBlueprint,
} from "@emerge/eval-terminal-bench";
```

## Task spec format

Tasks are YAML (or JSON) files matching the `TaskSpec` schema:

```yaml
id: my-task-001
title: Fix the broken function
repo:
  kind: inline
  files:
    src/util.py: |
      def add(a, b):
          return a - b   # BUG
    tests/test_util.py: |
      from src.util import add
      def test_add():
          assert add(1, 2) == 3
goal: Fix the add() function so pytest tests/ passes.
acceptanceCommand: python3 -m pytest tests/ -x -q
timeoutSeconds: 60
difficulty: trivial
```

Supported `repo.kind` values:
- `inline` — files are embedded in the spec; materialized to a temp directory
- `git` — spec contains `url` and optional `ref`; materialized via `git clone`

## Blueprint usage

```ts
import { loadTask, makeTerminalBenchBlueprint } from "@emerge/eval-terminal-bench";
import { AnthropicProvider } from "@emerge/provider-anthropic";

const task = (await loadTask("task.yaml")).value;
const provider = new AnthropicProvider(process.env.ANTHROPIC_API_KEY);

const { session, agentSpec } = makeTerminalBenchBlueprint({
  spec: task.spec,
  workspaceRoot: task.workspaceRoot,
  provider,
  sandboxMode: "inproc",  // or "harbor" for Docker isolation
});

const handle = (await session.kernel.spawn(agentSpec)).value;
await session.kernel.runAgent(handle);

session.stopAdjudicatorWatch();
await session.kernel.endSession();
await task.cleanup();
```

## Tool permissions in eval context

The `makeFsWriteTool` and `makeBashTool` ship with `permission.defaultMode: "ask"` —
appropriate for interactive sessions where a human approves writes. In eval context the
session builder wraps all tools with `defaultMode: "auto"` so the agent-runner passes
through to the sandbox immediately. The sandbox policy (InProcSandbox or HarborSandbox)
remains the real authorization gate.

## CLI

```
emerge-tbench run <task.yaml> [--sandbox inproc|harbor] [--image IMAGE]
```

Exit codes: `0` = aligned verdict, `1` = failed/partial, `2` = spec error.

## Sandbox modes

| Mode | Sandbox | Isolation | Use case |
|------|---------|-----------|----------|
| `inproc` | `InProcSandbox` | Process-level | Fast local testing, CI |
| `harbor` | `HarborSandbox` | Docker container | Strong isolation, benchmarking |

## Exports

```ts
// Task loading
export { loadTask, materializeTask, parseTaskSpec } from "./task-loader.js";
export type { TaskSpec, LoadedTask } from "./task-loader.js";

// Session wiring
export { buildSession } from "./session-builder.js";
export type { BuiltSession, SessionBuilderOptions, SandboxMode } from "./session-builder.js";

// Blueprint
export { makeTerminalBenchBlueprint } from "./blueprint.js";
export type { TerminalBenchBlueprint, TerminalBenchBlueprintOptions } from "./blueprint.js";

// Acceptance
export { runAcceptance, makeAcceptanceEvaluator } from "./acceptance-runner.js";
export type { AcceptanceResult } from "./acceptance-runner.js";
```
