# Roadmap

The canonical, in-repo roadmap. Reflects shipped work and the next-up
deliverables. Differs from the original `VISION.md` schedule because two
rounds of research (2026 agent landscape, then Terminal-Bench leaderboard)
revealed surfaces that should land sooner — and because the original
"M6: TUI" was way too late given the developer-experience requirement.

## Strategic pause (2026-04-19)

After M4-prep + the provider hardening work (retry + reasoning + tool-name
sanitization + `/v1` baseURL fix + empty-input fix), the project has
30+ packages, 505 tests, 38 ADRs of clean infrastructure — but **zero
public benchmark scores and zero real users**. Each first-contact with
a real model surface (today: gateway 502s, dotted tool names breaking
OpenAI spec, empty-input array, models choosing text over tool calls)
exposes friction that internal mock-driven testing cannot find.

**Decision: pause kernel feature work** (M4 persistence, M5 memory) and
shift focus to user-facing validation:

1. **Get one real Terminal-Bench 2.0 task to pass end-to-end** with a
   real model (not the mock). Debug whatever surfaces. The smoke
   demos pass; real tasks will not, on the first try.
2. **Publish v0.1 to npm** with an honest README — "infrastructure
   shipped, no leaderboard score yet." The act of publishing forces
   honest self-description.
3. **Find 3 specific people who care about the auditability /
   reproducibility / self-host thesis** (regulated industry, security
   teams, anyone needing verdict provenance + cost ledger + replay).
   Show them the dashboard + replay + verdict trail. Listen.

If real signal arrives in 2-3 weeks, resume M4/M5 with that signal.
If not, the dual thesis is right but market timing is wrong, and that
is a more expensive truth to surface late than early.

The deferred milestones below remain valid designs; they are paused,
not abandoned. The contracts they would build against are already
shipped at M0 and have survived 4 milestone rounds without change —
so the resume cost is low.

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

### M3c2.5 — In-memory ExperienceLibrary backend + smarter postmortem

`@emerge/experience-inmemory` ships `InMemoryExperienceLibrary` with
`hint / ingest / export / importBundle / get` working end-to-end. Merge-on-ingest
at configurable threshold (default 0.85) collapses repeated runs of the same
approach into one growing experience rather than N duplicates. Weighted similarity
scoring: approach 0.6 / taskType 0.3 / semantic (Jaccard) 0.1.

`defaultAnalyze` in `@emerge/agents` rewritten to compute a stable
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

### M4-prep — Terminal-Bench 2.0 runner + local validation
**Status: SHIPPED** (2026-04-18) — local smoke tests pass; public submission pending.

Driven by the April 2026 absorption pass: 7 of the top-10 leaderboard
entries use OpenAI/Codex backends; emerge has all three protocols
shipped (M3c1) but **0 public benchmark submissions**. Even a low score
(say 50%) backed by our auditability + reproducibility narrative is
more credible positioning than zero.

**Shipped:**
- `@emerge/eval-terminal-bench` — task loader, session builder, blueprint,
  acceptance runner, CLI (`emerge-tbench run <task.yaml>`).
- `@emerge/sandbox-harbor` — Docker-backed Sandbox for container isolation.
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

### M4 — Persistence + resume *(DEFERRED — see Strategic pause)*
**Goal:** sessions survive process restarts; long-running tasks resume
from the last completed tool.

- `@emerge/persistence-sqlite`. Tools are the checkpoint boundary
  (already established in ADR 0005). Resume reads recorded outputs;
  never re-prompts the model.
- `WorkspaceManager.list()` becomes durable across processes.
- The replay tier and the experience library both gain durable
  storage.

### M5 — Memory + experience write-back at scale *(DEFERRED — see Strategic pause)*
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
