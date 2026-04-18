# Roadmap

The canonical, in-repo roadmap. Reflects shipped work and the next-up
deliverables. Differs from the original `VISION.md` schedule because two
rounds of research (2026 agent landscape, then Terminal-Bench leaderboard)
revealed surfaces that should land sooner — and because the original
"M6: TUI" was way too late given the developer-experience requirement.

## Shipped (on `main`)

### M0 — Contracts frozen
PR [#NA — initial commit](https://github.com/LemonCANDY42/emerge/commit/d469a7b)

31 contract files in `packages/kernel/src/contracts/` covering kernel
primitives, comms / topology / safety, roles (Custodian / Adjudicator),
modes / permissions / cost, replay / experience, workspaces, speculative
branches, projections, human-in-loop, Standard Schema + W3C Trace Context.
30 ADRs in `docs/adr/` justifying every load-bearing decision.
`examples/types-smoke` instantiates every contract for CI regression
guard.

### M1 — Kernel runtime + bus + modes + replay + providers
[PR #1](https://github.com/LemonCANDY42/emerge/pull/1)

`@emerge/kernel/runtime`: bus + scheduler + agent-runner + lineage-guard +
cycle-guard + cost-meter + quota-router + Kernel facade. Plus
`provider-mock`, `provider-anthropic`, `sandbox-inproc`, `tools`,
`telemetry-jsonl`, `modes`, `replay`. Two demos: `hello-agent`,
`replay-smoke`. Review fix-up wired the load-bearing primitives that
weren't actually called from the agent loop initially.

### M2 — Surveillance + opaque adaptive decomposition + pinned reproducibility
[PR #2](https://github.com/LemonCANDY42/emerge/pull/2)

`@emerge/surveillance` with `CalibratedSurveillance`: rolling per-(provider,
difficulty) stats, all 5 recommendation kinds (proceed / decompose /
scaffold / escalate / defer), experience-hint scoring, sliding window. The
kernel now calls `assess()` before every step and `observe()` after every
step. Opaque decomposition module splits goals into ≤3 sub-steps and
injects one combined ToolResult to the inner agent. Pinned reproducibility
tier wired through both providers. Demos: `weak-model-decomposition`,
`cycle-guard-trip`.

### M3a — Topology + Custodian/Adjudicator/Postmortem + artifacts + workspaces
[PR #3](https://github.com/LemonCANDY42/emerge/pull/3)

`@emerge/agents`: `supervisorWorker` / `workerPool` / `pipeline` topology
builders, `buildCustodian` / `buildAdjudicator` / `buildPostmortem` role
helpers, `BlueprintRegistry` with typed slot validation. Plus
`@emerge/artifacts-local-fs` (atomic-write store) and
`@emerge/workspaces-git-worktree` (git-worktree allocator with tmpdir
fallback). Quota auto-routing: `quota.request` envelopes route to the
configured Custodian; `applyQuotaGrant` mutates the budget atomically.
Pinned-recall mechanism in `SimpleMemory` (always returns pinned items
regardless of budget). Adjudicator-gated `endSession()`. Demo:
`topology-supervisor-worker`.

### M3b — MCP + per-provider schema adapter + verification + truncation + vitest + real probes
[PR #4](https://github.com/LemonCANDY42/emerge/pull/4)

Driven by Terminal-Bench leaderboard research. `@emerge/tools-mcp`: MCP
client that wraps any MCP server's tools as kernel-registered Tools,
with name-collision protection and a permission-descriptor matrix.
Per-provider JSON schema adapter (recursive — handles Zod-generated
nested unions). Enforced post-step verification (opt-in, ADR-aligned
message ordering). Truncation-aware tool results (idempotent).
`vitest` infrastructure with **100 unit tests across 11 files**. Real
probe execution in `surveillance` (`runProbesAsync`) with
strict scoring + AbortSignal + telemetry. `examples/eval-probes` shows
weak-mock → ceiling `trivial`, strong-mock → ceiling `medium`.
`docs/design/terminal-bench-integration-plan.md` captures the
leaderboard-positioning + integration plan. ADRs 0031-0033.

### M3c1 — Architecture completion + provider extensions + real-model demos
PR (in flight)

Inbox unification: `AgentRunner` actually consumes `request` envelopes
addressed to it, so workers in topology helpers receive the supervisor's
payload (not just provider events). LLM-driven aggregation in
`supervisorWorker` (replaces the static JS reducer when no aggregator is
explicitly provided). Postmortem auto-invoke from `Kernel.endSession()`
when both `Postmortem` and `ExperienceLibrary` are mounted — closes the
read/write loop on the experience system. Provider extensions:
`@emerge/provider-openai` (Chat Completions + Responses API) and
`@emerge/provider-openai-compat` (any OpenAI-compatible endpoint —
Ollama, vLLM, llama.cpp, LM Studio, OpenRouter, your self-hosted
service). `@emerge/provider-anthropic` gains `extraHeaders`. Three new
demos: `hello-agent-anthropic`, `hello-agent-openai`,
`hello-agent-custom-url` (each runs against a real model when the env
var is set; exits 0 with a clear "skipped" message otherwise).

## Next up

### M3c2 — CLI + JSONL event schema + OTel emission
**Goal:** make emerge usable without writing TypeScript; make every
session observable in any OTel sink (Phoenix, Langfuse, …) with zero
self-built tooling.

- **JSONL event schema as a public contract.** Define every event the
  recorder emits as a versioned, documented schema. Becomes the
  source-of-truth that CLI / TUI / web / OTel all derive from.
- **`@emerge/telemetry-otel`** package. Emits per bus envelope + per
  surveillance verdict + per provider call + per tool call as OTel
  spans with W3C trace-context propagation. Compatible out-of-box with
  Phoenix (open-source self-hosted) and Langfuse.
- **`@emerge/cli`** package. Subcommands:
  - `emerge run <blueprint.yaml>` — runs a configured agent.
  - `emerge replay <session.jsonl>` — replays a recorded session
    (uses the M1 record-replay tier).
  - `emerge probe <provider-config>` — runs the calibrated probe set
    against a provider, prints the envelope.
  - `emerge status` — reads recent sessions, prints recent topology
    + cost + verdicts.
- A small Phoenix / Langfuse integration guide in `docs/integrations/`.

### M3c2.5 — Minimal experience-library backend
**Goal:** close the surveillance/experience self-improving loop with a
real-running backend before competition catches up.

Driven by the April 2026 absorption pass (`docs/design/leaderboard-absorption-2026-04.md`):
OpenDev (arXiv 2603.05344) shipped the closest published analog to our
`Experience` library — a "playbook of learned strategies that evolve
based on feedback." Our differentiator only holds if we have a
real-running backend, not a contract-with-no-impl.

- `@emerge/experience-inmemory` package. In-memory `ExperienceLibrary`
  implementation with `hint` / `ingest` / `export` / `importBundle` /
  `get` working end-to-end. Persistence comes in M4; this milestone
  proves the loop runs.
- Wire `Kernel.mountExperienceLibrary()` into the existing
  `agent-runner` `surveillance.assess()` path so `experienceHints` are
  actually populated when a library is mounted (currently always
  `undefined`).
- Update `examples/topology-supervisor-worker` to mount the library +
  show that a second session of the same task gets a faster path
  because the postmortem-derived experience hints surveillance.
- One ADR on experience storage / merge semantics so M5's persistent
  backend builds on the same shape.

### M3d — TUI + Web monitor
**Goal:** see what the harness is doing in real time, in the terminal
or the browser.

- **`@emerge/tui`** (Ink + React). Live topology tree, verdict feed,
  per-agent cost counter, pinned-context viewer, replay scrubber.
  Subscribes to the bus directly when running in-process; reads JSONL
  when replaying.
- **`@emerge/dashboard`** (Vite + React + WebSocket). Same data, in a
  browser. Topology graph (force-directed), trace timeline,
  cost/performance charts, verdict explorer. Single command:
  `emerge dashboard --session <id>` opens a local web view; `--listen`
  exposes it for remote.
- These are differentiated from Mastra's Agent Studio (workflow-focused)
  and VoltAgent's VoltOps (flowchart-focused) by surfacing
  contract-enforcement verdicts and Custodian/Adjudicator decisions as
  first-class UI elements.

### M4-prep — First Terminal-Bench 2.0 public submission
**Goal:** a real number on a public leaderboard, not just a contract.

Driven by the April 2026 absorption pass: 7 of the top-10 leaderboard
entries use OpenAI/Codex backends; emerge has all three protocols
shipped (M3c1) but **0 public benchmark submissions**. Even a low score
(say 50%) backed by our auditability + reproducibility narrative is
more credible positioning than zero.

- Build `@emerge/eval-terminal-bench` per the existing plan in
  `docs/design/terminal-bench-integration-plan.md`.
- `@emerge/sandbox-harbor` for the Docker / container exec path.
- A `TerminalBenchBlueprint` that ships sensible defaults
  (active surveillance, `record-replay` reproducibility tier so each
  attempt is reproducible, mounted Custodian + Adjudicator with strict
  verification gate).
- Submit one public run to tbench.ai with the result + the SessionRecord
  bundle published as evidence. Goal: prove the architecture runs
  end-to-end against a third-party evaluator, surface real bottlenecks.

This is intentionally pre-M4 (persistence) because TB 2.0 tasks fit in
single-process sessions; persistence is M4 only after we know what the
real bottlenecks are.

### M4 — Persistence + resume
**Goal:** sessions survive process restarts; long-running tasks resume
from the last completed tool.

- `@emerge/persistence-sqlite`. Tools are the checkpoint boundary
  (already established in ADR 0005). Resume reads recorded outputs;
  never re-prompts the model.
- `WorkspaceManager.list()` becomes durable across processes.
- The replay tier and the experience library both gain durable
  storage.

### M5 — Memory + experience write-back at scale
**Goal:** smarter session-over-session through a real
ExperienceLibrary backend.

- `@emerge/memory-sqlite` with multi-strategy associative recall
  (semantic + structural + temporal + causal) and a real
  `RecallTrace`. Compression runs out-of-band; pinned items are
  non-droppable.
- `@emerge/experience-sqlite` with merge-optimization on ingest,
  bundle import / export, and similarity-based cross-session
  matching. Postmortem now drives a real learning loop.
- Surveillance's `experienceHints` consume real priors.

### Beyond M5
- **Speculative branch-and-merge**: contracts shipped at M0; impl waits
  for the topology helpers and persistence layer to mature.
- **Sandbox-docker / sandbox-microvm**: real isolation for production
  deployments.
- **Terminal-Bench wiring** (`@emerge/eval-terminal-bench`,
  `@emerge/sandbox-harbor`, `TerminalBenchBlueprint`): the Python
  bridge + container exec + the standard agent blueprint that runs
  Harbor tasks. Plan in `docs/design/terminal-bench-integration-plan.md`.
- **mesh / tree / debate topologies**: more topology builders once the
  base patterns prove stable.
- **VS Code extension**: sidebar reading the JSONL stream (M3c2's
  schema unlocks this).

## Shape of the project (after M3d)

```
                   ┌────────────────────────────────────────────────┐
                   │  cli   tui   dashboard   vscode-extension      │  surfaces
                   └────────────────────────────────────────────────┘
                                          │
                   ┌──────────────────────▼─────────────────────────┐
                   │  JSONL event schema (public contract)          │
                   │  OTel emission → Phoenix / Langfuse / …        │
                   └──────────────────────┬─────────────────────────┘
                                          │
                   ┌──────────────────────▼─────────────────────────┐
                   │           agents (topologies + roles)          │
                   └──────────────────────┬─────────────────────────┘
                                          │
                   ┌──────────────────────▼─────────────────────────┐
                   │                    kernel                      │
                   │   loop · bus · scheduler · lifecycle · guards  │
                   └──────────────────────┬─────────────────────────┘
                                          │
   ┌──────────┬──────────┬─────────┬──────▼─────────┬───────────────┐
   │ provider │  memory  │  tools  │   sandbox      │  surveillance │  modules
   │ (multi)  │  (M5)    │  (+MCP) │ (inproc/dock)  │   (M2)        │
   └──────────┴──────────┴─────────┴────────────────┴───────────────┘
```

The contracts (the heart) are frozen at M0. Everything above is
swappable; everything below implements a single interface.
