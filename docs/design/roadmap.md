# Roadmap

The canonical, in-repo roadmap. Reflects shipped work and the next-up
deliverables. Differs from the original `VISION.md` schedule because two
rounds of research (2026 agent landscape, then Terminal-Bench leaderboard)
revealed surfaces that should land sooner — and because the original
"M6: TUI" was way too late given the developer-experience requirement.

## Strategic pause note (2026-04-19 → resumed 2026-04-20)

After v0.1.0 shipped (30+ packages, 505 tests, 38 ADRs, real-model
verified), the project paused kernel feature work to validate the
auditability + reproducibility thesis with real users and a real
benchmark score. That pause is now **resolved**: per user direction
2026-04-20, M4 / M5 / topologies / UI work resumes based on the
research-driven handoff in
[`docs/design/v0.2-handoff.md`](./v0.2-handoff.md).

User-finding (Terminal-Bench public submission + finding 3
regulated-industry users) remains paused — not abandoned. The
benchmark submission and user outreach are post-v0.2 activities;
M4 / M5 / topologies / UI work resumes per user direction 2026-04-20.
The "find 3 users" part of the pause remains paused — user-finding
happens in parallel with v0.2 dev, not as a gate.

The contracts the deferred milestones build against have survived 4
milestone rounds + 2 research absorption passes without change — so
the resume cost is low.

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

`@lwrf42/emerge-kernel/runtime`: bus + scheduler + agent-runner + lineage-guard +
cycle-guard + cost-meter + quota-router + Kernel facade. Plus
`provider-mock`, `provider-anthropic`, `sandbox-inproc`, `tools`,
`telemetry-jsonl`, `modes`, `replay`. Two demos: `hello-agent`,
`replay-smoke`. Review fix-up wired the load-bearing primitives that
weren't actually called from the agent loop initially.

### M2 — Surveillance + opaque adaptive decomposition + pinned reproducibility
[PR #2](https://github.com/LemonCANDY42/emerge/pull/2)

`@lwrf42/emerge-surveillance` with `CalibratedSurveillance`: rolling per-(provider,
difficulty) stats, all 5 recommendation kinds (proceed / decompose /
scaffold / escalate / defer), experience-hint scoring, sliding window. The
kernel now calls `assess()` before every step and `observe()` after every
step. Opaque decomposition module splits goals into ≤3 sub-steps and
injects one combined ToolResult to the inner agent. Pinned reproducibility
tier wired through both providers. Demos: `weak-model-decomposition`,
`cycle-guard-trip`.

### M3a — Topology + Custodian/Adjudicator/Postmortem + artifacts + workspaces
[PR #3](https://github.com/LemonCANDY42/emerge/pull/3)

`@lwrf42/emerge-agents`: `supervisorWorker` / `workerPool` / `pipeline` topology
builders, `buildCustodian` / `buildAdjudicator` / `buildPostmortem` role
helpers, `BlueprintRegistry` with typed slot validation. Plus
`@lwrf42/emerge-artifacts-local-fs` (atomic-write store) and
`@lwrf42/emerge-workspaces-git-worktree` (git-worktree allocator with tmpdir
fallback). Quota auto-routing: `quota.request` envelopes route to the
configured Custodian; `applyQuotaGrant` mutates the budget atomically.
Pinned-recall mechanism in `SimpleMemory` (always returns pinned items
regardless of budget). Adjudicator-gated `endSession()`. Demo:
`topology-supervisor-worker`.

### M3b — MCP + per-provider schema adapter + verification + truncation + vitest + real probes
[PR #4](https://github.com/LemonCANDY42/emerge/pull/4)

Driven by Terminal-Bench leaderboard research. `@lwrf42/emerge-tools-mcp`: MCP
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
`@lwrf42/emerge-provider-openai` (Chat Completions + Responses API) and
`@lwrf42/emerge-provider-openai-compat` (any OpenAI-compatible endpoint —
Ollama, vLLM, llama.cpp, LM Studio, OpenRouter, your self-hosted
service). `@lwrf42/emerge-provider-anthropic` gains `extraHeaders`. Three new
demos: `hello-agent-anthropic`, `hello-agent-openai`,
`hello-agent-custom-url` (each runs against a real model when the env
var is set; exits 0 with a clear "skipped" message otherwise).

### M3c2.5 — In-memory ExperienceLibrary backend + smarter postmortem

`@lwrf42/emerge-experience-inmemory` ships `InMemoryExperienceLibrary` with
`hint / ingest / export / importBundle / get` working end-to-end. Merge-on-ingest
at configurable threshold (default 0.85) collapses repeated runs of the same
approach into one growing experience rather than N duplicates. Weighted similarity
scoring: approach 0.6 / taskType 0.3 / semantic (Jaccard) 0.1.

`defaultAnalyze` in `@lwrf42/emerge-agents` rewritten to compute a stable
`approachFingerprint` from session structure — the hash of (tools used,
surveillance recommendations, decision choices) — not from session identity.
`deriveTaskType` now returns `record.contractRef` (stable, always present) as the
primary task key, so the query key in `AgentRunner` and the stored key in the
library always agree.

The `hint()` fetch in `AgentRunner` was hoisted before the surveillance gate so
the read half of the loop runs whenever a library is mounted, regardless of
whether full surveillance is active. This closes the
postmortem→experience→hint loop without requiring a `CalibratedSurveillance`
instance.

`examples/topology-supervisor-worker` updated to run the same task twice with a
shared `HintCountingLibrary`. Run 1 sees zero hints (library empty); Run 2 sees
≥1 hint with results (library holds run 1's merged experience). The demo exits 0.

ADR 0038 documents the storage / merge / query design and the M5 migration path.
Test count: 243 (up from 207 at M3c1 start).

## Next up

### M3c2 — CLI + JSONL event schema + OTel emission
**Goal:** make emerge usable without writing TypeScript; make every
session observable in any OTel sink (Phoenix, Langfuse, …) with zero
self-built tooling.

- **JSONL event schema as a public contract.** Define every event the
  recorder emits as a versioned, documented schema. Becomes the
  source-of-truth that CLI / TUI / web / OTel all derive from.
- **`@lwrf42/emerge-telemetry-otel`** package. Emits per bus envelope + per
  surveillance verdict + per provider call + per tool call as OTel
  spans with W3C trace-context propagation. Compatible out-of-box with
  Phoenix (open-source self-hosted) and Langfuse.
- **`@lwrf42/emerge-cli`** package. Subcommands:
  - `emerge run <blueprint.yaml>` — runs a configured agent.
  - `emerge replay <session.jsonl>` — replays a recorded session
    (uses the M1 record-replay tier).
  - `emerge probe <provider-config>` — runs the calibrated probe set
    against a provider, prints the envelope.
  - `emerge status` — reads recent sessions, prints recent topology
    + cost + verdicts.
- A small Phoenix / Langfuse integration guide in `docs/integrations/`.

### M3d — TUI + Web monitor
**Goal:** see what the harness is doing in real time, in the terminal
or the browser.

- **`@lwrf42/emerge-tui`** (Ink + React). Live topology tree, verdict feed,
  per-agent cost counter, pinned-context viewer, replay scrubber.
  Subscribes to the bus directly when running in-process; reads JSONL
  when replaying.
- **`@lwrf42/emerge-dashboard`** (Vite + React + WebSocket). Same data, in a
  browser. Topology graph (force-directed), trace timeline,
  cost/performance charts, verdict explorer. Single command:
  `emerge dashboard --session <id>` opens a local web view; `--listen`
  exposes it for remote.
- These are differentiated from Mastra's Agent Studio (workflow-focused)
  and VoltAgent's VoltOps (flowchart-focused) by surfacing
  contract-enforcement verdicts and Custodian/Adjudicator decisions as
  first-class UI elements.

### M4-prep — Terminal-Bench 2.0 runner + local validation
**Status: SHIPPED** (2026-04-18) — local smoke tests pass; public submission pending.

Driven by the April 2026 absorption pass: 7 of the top-10 leaderboard
entries use OpenAI/Codex backends; emerge has all three protocols
shipped (M3c1) but **0 public benchmark submissions**. Even a low score
(say 50%) backed by our auditability + reproducibility narrative is
more credible positioning than zero.

**Shipped:**
- `@lwrf42/emerge-eval-terminal-bench` — task loader, session builder, blueprint,
  acceptance runner, CLI (`emerge-tbench run <task.yaml>`).
- `@lwrf42/emerge-sandbox-harbor` — Docker-backed Sandbox for container isolation.
- `TerminalBenchBlueprint` with sensible defaults (20 iterations, 100k/8k
  token budget, fs.read + fs.write + bash tools, adjudicator watching bus).
- Two smoke examples: `tbench-smoke-inline` (InProcSandbox, no Docker) and
  `tbench-smoke-docker` (HarborSandbox, `python:3.12-slim`). Both PASS.
- `M4-PREP-SELF-TEST-REPORT.md` at repo root with actual console output.

**Key fix:** `fs.write` and `bash` ship with `defaultMode: "ask"`. The session
builder wraps all eval tools with `defaultMode: "auto"` so the agent-runner
passes through to the sandbox immediately; the sandbox policy is the real gate.

**Pending (before public submission):**
- Real provider run (AnthropicProvider or OpenAIProvider) against actual tasks.
- Task discovery from a manifest / directory for batch runs.
- Structured JSON result output for leaderboard submission.
- Container reuse or pre-installed pytest image to cut cold-start overhead.

This is intentionally pre-M4 (persistence) because TB 2.0 tasks fit in
single-process sessions; persistence is M4 only after we know what the
real bottlenecks are.

### M4 — Persistence + resume *(v0.2 — In progress)*
**Goal:** sessions survive process restarts; long-running tasks resume
from the last completed tool call without re-executing anything.

See [`docs/design/v0.2-handoff.md`](./v0.2-handoff.md) §7.1 for the
full design sketch.

- `@lwrf42/emerge-persistence-sqlite`: SQLite (`better-sqlite3`)
  checkpoint store. Schema: `sessions` + `checkpoints` (keyed on
  `session_id, tool_call_id`) + `provider_calls` + `verdicts` +
  `bg_processes`. `PRAGMA user_version = 1` for schema versioning;
  rebuild on mismatch.
- Session index: `~/.emerge/sessions/index.jsonl` (one line per
  session) for fast `emerge status` listing without parsing all
  session JSONL.
- `Kernel.spawn()` gains optional `resumeSessionId`; already-completed
  tool calls return recorded results (idempotent replay, never
  re-executes).
- `WorkspaceManager.list()` reads from the `sessions` table (durable
  across restarts).
- `emerge status` CLI subcommand: lists all sessions with start / end
  time, contract ref, cost, and verdict.
- New built-in tools (Droid + TongAgents pattern): `env.bootstrap`
  (one-shot environmental probe), `bash.background` /
  `bash.poll` / `bash.kill` triple, `tool.async_complete` bus
  envelope, `tool_progress` JSONL event.
- Migration: existing JSONL sessions remain readable;
  `emerge index <session-id>` builds the SQLite index from JSONL on
  demand.
- ADR 0039: persistence storage choice.

### M5 — Memory + experience at scale *(v0.2 — In progress)*
**Goal:** smarter session-over-session through a real multi-strategy
memory backend.

See [`docs/design/v0.2-handoff.md`](./v0.2-handoff.md) §7.2 for the
full design sketch.

- `@lwrf42/emerge-memory-sqlite`: SQLite source-of-truth + sqlite-vec
  semantic index. Four-strategy recall: semantic (sqlite-vec
  brute-force, 384-dim embeddings via `@xenova/transformers` worker
  thread) + structural (SQL JSON extract) + temporal (SQL date range)
  + causal (recursive CTE on `memory_links` with SageAgent typed-edge
  enum: `caused / refers / summarizes / supersedes / contradicts`).
  `RecallTrace` on every recall per ADR 0004. Compression pipeline:
  working → episodic (token-threshold trigger) → archived (time-based).
  Pinned items non-droppable at all tiers.
- `@lwrf42/emerge-experience-sqlite`: persistent `ExperienceLibrary`
  backend. Same SQLite file as memory; indexed on `(task_type,
  approach_fp)`. Replaces `emerge-experience-inmemory` for production
  deployments that need cross-restart experience persistence.
- Surveillance's `experienceHints` now survive process restarts;
  `topology-supervisor-worker` extended assertion: kill the process
  between run 1 and run 2; restart; run 2 still sees hints from run 1.
- ADR 0040: memory recall architecture (sqlite-vec default; LanceDB
  documented as migration path for > 1M items or BM25 hybrid search
  requirement).

### mesh / tree / debate topologies *(v0.2 — In progress)*
**Goal:** demonstrate emergent efficiency on real tasks with
multi-agent coordination beyond the existing supervisor / worker /
pool / pipeline patterns.

See [`docs/design/v0.2-handoff.md`](./v0.2-handoff.md) §7.3 for API
sketches and demo plans.

- `mesh()` builder: all-to-all bus ACL, shared broadcast topic,
  quiescence termination (all agents reach `idle` state per MetaGPT
  pattern), `maxTurns` ceiling, `maxMembers = 6` ceiling (N²
  enforcement — use `tree()` beyond 6).
- `tree()` builder: recursive `supervisorWorker` instances using
  `Topology.nested`. Root decomposes → mid-level supervisors → leaf
  workers; results propagate upward. Per-level `providerHint`
  accepted (SageAgent heterogeneous-model pattern). Optional
  `reviewer` peer at each level (Capy pattern).
- `debate()` builder: N debaters (each with assigned stance) + 1 LLM
  moderator. Moderator calls
  `select_next_speaker(candidates, truncated_history)` each round;
  calls `terminate(resolution)` to end. Pattern: AutoGen
  `SelectorGroupChat` adapted to emerge's bus.
- All three accept a per-leaf workspace strategy (default: one git
  worktree per leaf agent — Capy pattern).
- Specialist blueprints
  (`code-worker / knowledge-worker / ops-worker / qa-worker`) ship
  alongside as composable building blocks for `tree()` (Droid
  pattern).
- Efficiency measurement: success_rate / token_cost vs. single-agent
  baseline for each topology at 3 agent-count configurations.
  Reported as a 3 × 4 matrix per topology.
- ADR 0041: mesh / tree / debate topology semantics.

### Interactive TUI + web visualization *(v0.2 — In progress)*
**Goal:** topology graph clickable with per-agent drill-down; TUI
panel-switching; global view in browser.

See [`docs/design/v0.2-handoff.md`](./v0.2-handoff.md) §7.4 for the
implementation sketch.

- TUI: `Tab` cycles panels (topology / verdicts / inspector / cost /
  pinned); `Enter` selects an agent for the inspector panel; `Esc`
  returns. New `AgentInspector` component shows role, state, token
  usage, verdicts, pinned items.
- Dashboard `TopologyGraph.tsx`: upgraded from pure SVG to
  `@xyflow/react` + ELK.js auto-layout. Clickable agent nodes open a
  right-panel `AgentInspector`. Supports mesh cross-edges (not
  possible with the BFS SVG layout).
- Dashboard `AgentInspector`: message history (last 20), tool calls
  (last 10), all verdicts for the selected agent.
- Dashboard URL: `?agent=<id>` deep-links to the agent inspector for
  sharing and bookmarking (Phoenix pattern).
- WebSocket bridge: + `agent.selected` (client → server) and
  + `agent.detail` (server → client) RPC frame kinds.
- ADR 0042: interactive UI navigation and drill-down model.

### Beyond M5
- **Speculative branch-and-merge**: contracts shipped at M0; impl waits
  for the topology helpers and persistence layer to mature.
- **Sandbox-docker / sandbox-microvm**: real isolation for production
  deployments.
- **Terminal-Bench wiring** (`@lwrf42/emerge-eval-terminal-bench`,
  `@lwrf42/emerge-sandbox-harbor`, `TerminalBenchBlueprint`): the Python
  bridge + container exec + the standard agent blueprint that runs
  Harbor tasks. Plan in `docs/design/terminal-bench-integration-plan.md`.
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
