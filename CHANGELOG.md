# CHANGELOG

## v0.2.0 — In progress

Four workstreams (see [`docs/design/v0.2-handoff.md`](./docs/design/v0.2-handoff.md)):
- M4 — Persistence + Resume
- M5 — Memory at scale
- mesh / tree / debate topologies
- Interactive TUI + web visualization

Built on absorbed ideas from Claude Code (memory layout), Aider (repomap),
top TB 2.0 frameworks (ForgeCode, TongAgents, SageAgent, Droid, Capy),
AutoGen group chat (mesh + debate), Phoenix UI (drill-down), and others.

### M4 — Persistence + Resume

- `@lwrf42/emerge-persistence-sqlite`: tool-call checkpointing in SQLite
  (`better-sqlite3`); `PRAGMA user_version` schema versioning; session
  index (`~/.emerge/sessions/index.jsonl`)
- `Kernel.spawn()` gains optional `resumeSessionId`; already-completed
  tool calls return recorded results without re-execution
- `WorkspaceManager.list()` becomes durable across process restarts
- `emerge status` CLI subcommand lists all sessions
- New built-in tools (Droid + TongAgents pattern): `env.bootstrap`,
  `bash.background` / `bash.poll` / `bash.kill` triple,
  `tool.async_complete` bus envelope, `tool_progress` JSONL event

### M5 — Memory at scale

- `@lwrf42/emerge-memory-sqlite`: multi-strategy recall
  (semantic + structural + temporal + causal), real `RecallTrace` per
  ADR 0004, sqlite-vec for semantic indexing, embedding worker thread
  (`@xenova/transformers`); SageAgent-inspired typed-edge enum on
  `memory_links` (`caused / refers / summarizes / supersedes /
  contradicts`)
- `@lwrf42/emerge-experience-sqlite`: persistent `ExperienceLibrary`
  backend (replaces `emerge-experience-inmemory` for durable
  deployments)
- Compression pipeline: working → episodic (token-threshold) →
  archived (time-based); pinned items non-droppable at all tiers
- `examples/memory-ablation/` reports success-rate + token-cost across
  the four recall strategies (SageAgent ablation pattern)

### mesh / tree / debate topologies

- `mesh()` topology builder: all-to-all ACL, shared broadcast topic,
  quiescence termination, `maxMembers = 6` ceiling (N² enforcement)
- `tree()` topology builder: recursive `supervisorWorker` using
  `Topology.nested`; per-level `providerHint` for heterogeneous-model
  composition (SageAgent pattern); optional `reviewer` peer per level
  (Capy pattern)
- `debate()` topology builder: N debaters + LLM moderator
  (`select_next_speaker` + `terminate` tools)
- Per-leaf workspace strategy defaults to one git worktree per leaf
  agent (Capy pattern)
- Specialist blueprints
  (`code-worker / knowledge-worker / ops-worker / qa-worker` —
  Droid pattern)
- Three new demo examples (one per topology); efficiency measurement
  (success_rate / token_cost vs. single-agent baseline) per demo

### Interactive TUI + web visualization

- TUI: panel-key-switching (`Tab`), `AgentInspector` panel
  (arrow-key navigation, `Enter` to select, `Esc` to return)
- Dashboard `TopologyGraph.tsx`: pure SVG → `@xyflow/react` + ELK.js
  auto-layout; clickable agent nodes
- Dashboard `AgentInspector` side panel: message history, tool calls,
  verdicts per agent
- Dashboard: `?agent=<id>` URL parameter for deep-linking (Phoenix
  pattern)
- WebSocket bridge: + `agent.selected` and + `agent.detail` RPC frame
  kinds

### ADRs reserved

0039 (persistence storage) · 0040 (memory recall) · 0041 (mesh / tree /
debate semantics) · 0042 (interactive UI navigation)

---

## v0.1.0 — 2026-04

First npm publish of the `@lwrf42/emerge-*` package family. Packages are published under the `@lwrf42` personal npm scope because the `@emerge` org is not yet registered on npm. The package contents and import shape (modulo the scope prefix) match what `@emerge/*` will be once that org is claimed.

### What shipped

**M0 — Kernel foundation**
- `@lwrf42/emerge-kernel`: contracts (AgentSpec, AgentHandle, Kernel, MessageBus, ToolSpec, SandboxEffect, TelemetryEvent, and 30+ more), scheduler, message bus, lifecycle, permission guards, inbox unification, Postmortem auto-invoke

**M1 — Core modules**
- `@lwrf42/emerge-provider-mock`: scripted mock provider for tests and demos
- `@lwrf42/emerge-provider-anthropic`: Anthropic Claude adapter with baseURL + extraHeaders support
- `@lwrf42/emerge-sandbox-inproc`: in-process sandbox with permission policy
- `@lwrf42/emerge-tools`: tool registry, fs read/write, bash tool
- `@lwrf42/emerge-tools-mcp`: MCP (Model Context Protocol) tool bridge
- `@lwrf42/emerge-modes`: built-in mode definitions (auto/plan/bypass/accept-edit/research/read) + ModeRegistry
- `@lwrf42/emerge-replay`: session recorder + deterministic replayer
- `@lwrf42/emerge-telemetry-jsonl`: JSONL-backed telemetry writer

**M2 — Surveillance**
- `@lwrf42/emerge-surveillance`: capability probing, adaptive decomposition, experience hints as priors

**M3 — Multi-agent topology + providers**
- `@lwrf42/emerge-agents`: supervisor/worker/pool/pipeline topologies, Adjudicator, Custodian
- `@lwrf42/emerge-provider-openai`: OpenAI adapter (chat + responses protocols, custom baseURL)
- `@lwrf42/emerge-provider-openai-compat`: thin wrapper for any OpenAI-compatible endpoint
- `@lwrf42/emerge-artifacts-local-fs`: local-filesystem artifact store
- `@lwrf42/emerge-workspaces-git-worktree`: git worktree + scoped-tmpdir workspace managers
- `@lwrf42/emerge-experience-inmemory`: in-memory ExperienceLibrary with postmortem distillation
- `@lwrf42/emerge-telemetry-otel`: OpenTelemetry exporter (Phoenix, Langfuse, Jaeger)
- `@lwrf42/emerge-tui`: Ink+React live terminal monitor with topology, verdicts, cost, replay scrubber
- `@lwrf42/emerge-dashboard`: Vite+React+WebSocket browser dashboard
- `@lwrf42/emerge-cli`: `emerge run/replay/probe/status` CLI

**M4 — Eval + real-model validation**
- `@lwrf42/emerge-eval-terminal-bench`: Terminal-Bench task runner (task loader, session builder, blueprint, acceptance runner, CLI)
- `@lwrf42/emerge-sandbox-harbor`: Docker-container sandbox (HarborSandbox)
- Real-model end-to-end validation against `gpt-5.4` via OpenAI-compatible gateway: 3 tracks (Docker, replay, multi-step) all PASS
- Adjudicator async-`stopAdjudicatorWatch` fix (race condition between in-flight evaluate() and endSession())

### Test suite

- 505 tests passing, 4 skipped, 38 ADRs

### Known limitations

- Only `gpt-5.4` via one custom gateway verified with real model; Anthropic, direct OpenAI, and local models are shipped but unverified
- Memory (episodic + semantic) planned for M5; not yet shipped
- Persistence (durable task graphs, checkpoints, resume) planned for M4+
