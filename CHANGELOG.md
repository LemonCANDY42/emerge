# CHANGELOG

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
