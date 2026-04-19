# CHANGELOG

## v0.1.0 — 2026-04

First npm publish of the `@emerge/*` package family.

### What shipped

**M0 — Kernel foundation**
- `@emerge/kernel`: contracts (AgentSpec, AgentHandle, Kernel, MessageBus, ToolSpec, SandboxEffect, TelemetryEvent, and 30+ more), scheduler, message bus, lifecycle, permission guards, inbox unification, Postmortem auto-invoke

**M1 — Core modules**
- `@emerge/provider-mock`: scripted mock provider for tests and demos
- `@emerge/provider-anthropic`: Anthropic Claude adapter with baseURL + extraHeaders support
- `@emerge/sandbox-inproc`: in-process sandbox with permission policy
- `@emerge/tools`: tool registry, fs read/write, bash tool
- `@emerge/tools-mcp`: MCP (Model Context Protocol) tool bridge
- `@emerge/modes`: built-in mode definitions (auto/plan/bypass/accept-edit/research/read) + ModeRegistry
- `@emerge/replay`: session recorder + deterministic replayer
- `@emerge/telemetry-jsonl`: JSONL-backed telemetry writer

**M2 — Surveillance**
- `@emerge/surveillance`: capability probing, adaptive decomposition, experience hints as priors

**M3 — Multi-agent topology + providers**
- `@emerge/agents`: supervisor/worker/pool/pipeline topologies, Adjudicator, Custodian
- `@emerge/provider-openai`: OpenAI adapter (chat + responses protocols, custom baseURL)
- `@emerge/provider-openai-compat`: thin wrapper for any OpenAI-compatible endpoint
- `@emerge/artifacts-local-fs`: local-filesystem artifact store
- `@emerge/workspaces-git-worktree`: git worktree + scoped-tmpdir workspace managers
- `@emerge/experience-inmemory`: in-memory ExperienceLibrary with postmortem distillation
- `@emerge/telemetry-otel`: OpenTelemetry exporter (Phoenix, Langfuse, Jaeger)
- `@emerge/tui`: Ink+React live terminal monitor with topology, verdicts, cost, replay scrubber
- `@emerge/dashboard`: Vite+React+WebSocket browser dashboard
- `@emerge/cli`: `emerge run/replay/probe/status` CLI

**M4 — Eval + real-model validation**
- `@emerge/eval-terminal-bench`: Terminal-Bench task runner (task loader, session builder, blueprint, acceptance runner, CLI)
- `@emerge/sandbox-harbor`: Docker-container sandbox (HarborSandbox)
- Real-model end-to-end validation against `gpt-5.4` via OpenAI-compatible gateway: 3 tracks (Docker, replay, multi-step) all PASS
- Adjudicator async-`stopAdjudicatorWatch` fix (race condition between in-flight evaluate() and endSession())

### Test suite

- 505 tests passing, 4 skipped, 38 ADRs

### Known limitations

- Only `gpt-5.4` via one custom gateway verified with real model; Anthropic, direct OpenAI, and local models are shipped but unverified
- Memory (episodic + semantic) planned for M5; not yet shipped
- Persistence (durable task graphs, checkpoints, resume) planned for M4+
