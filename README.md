# emerge

> A next-generation agent harness — model-agnostic, multi-agent native, and self-aware.

**Status:** early. Contracts are landing. Implementations follow.

`emerge` is a TypeScript harness for building durable, model-aware AI agents.
Where most harnesses assume one model, one agent, one shot, `emerge` treats
*the model itself as a runtime variable* — measuring its competence on the fly
and adapting task structure to fit.

## What makes it different

- **Model surveillance.** The harness continuously probes the active model's
  competence on the current task. When the gap is too wide, it *automatically*
  re-plans with finer decomposition or escalates to a stronger model. Weak
  models complete bigger tasks because the harness shrinks each step until it
  fits — across nested, opaque layers.
- **Multi-agent as a primitive.** Sub-agents, supervisors, and a streaming,
  bidirectional, addressable message bus are first-class kernel concepts.
  Topology is a *value* — supervisor / worker / pool / swarm / mesh / tree /
  pipeline / debate, nestable, with mandatory loop / recursion / mutual-respawn
  safeguards.
- **Contract Custodian + Compliance Adjudicator.** A dedicated agent role
  holds the master work contract verbatim through a pinned-context discipline
  that survives any compression. A separate evaluator gates completion against
  acceptance criteria. Children may negotiate quota mid-flight.
- **AgentBlueprint composition.** Specialized agents are *assembled* from
  typed slots, not subclassed — plug-and-play domain capability.
- **Pluggable kernel.** Provider, memory, tools, sandbox, telemetry,
  surveillance, modes, replay, experience, workspaces are swappable modules
  behind small, stable contracts. Wire your own; don't fork the harness.
- **Long-horizon by default.** Tasks are durable. Sessions resume across
  processes. Background work is a primitive, not a hack.
- **Associative recall.** Context is retrieved by semantic + structural +
  temporal + causal proximity — not last-N or naive grep — and every recall
  returns an explainable trace.
- **Token-frugal by design.** On-demand skill loading, layered compression,
  diff-only context updates, tool-result handles, and per-agent tool-result
  projections that strip / redact / cap / project before tokens hit the model.
- **Operating modes + permission management.** `auto / plan / bypass /
  accept-edit / research / read` built-in; user-defined modes pluggable;
  per-mode `PermissionPolicy` enforced at the kernel/sandbox boundary.
- **Cost as a first-class observable.** Per-call USD reported by providers;
  rolled up per agent / topology / contract; pre-flight forecast; cost
  ceilings enforced like any other budget.
- **Honest reproducibility.** Three tiers — `record-replay` (replays from log;
  fully reproducible), `pinned` (best-effort with logged divergence), `free`.
  No dishonest "same seed → same output" claims.
- **Replay-grounded experience library.** Every session is recorded;
  postmortem analysis distills `Experience`s keyed by problem-solving
  approach (not topic); surveillance reads them as priors at session start.
  Bundles are exportable / importable / mergeable for community sharing.
- **Human-in-the-loop is a primitive**, not a tool — `human.request /
  human.reply / human.timeout` envelopes; async approval queue.
- **Workspace isolation.** Each agent / topology branch / speculative branch
  gets an addressable `Workspace` (default: git worktree); merges are
  explicit, so parallel agents don't trample each other.
- **Standard Schema everywhere.** All contract boundaries use
  `standardschema.dev`-compatible refs — bring Zod, Valibot, ArkType.
- **OpenTelemetry + W3C Trace Context** end-to-end across nested agents.

## Influences (and what we changed)

`emerge` studies — but does not copy — the public design conversation around
Claude Code and similar harnesses. We borrow what's elegant (the loop,
on-demand skill loading, sub-agent context isolation, polished TUI ergonomics)
and reject what's constraining (single-vendor lock-in, single-agent
assumptions, opaque kernel).

See [VISION.md](./VISION.md) for the why and [ARCHITECTURE.md](./ARCHITECTURE.md)
for the how.

## Try it with a real model

Run the hello-agent task (read README.md, write NOTES.md) against any of the three supported protocols. Each demo exits 0 with a "skipped" message when the env var is absent — safe in CI.

```bash
pnpm install && pnpm build
```

**Anthropic (Claude):**
```bash
ANTHROPIC_API_KEY=sk-ant-... node examples/hello-agent-anthropic/dist/index.js
# Optional: ANTHROPIC_BASE_URL=... ANTHROPIC_MODEL=claude-opus-4-7
```

**OpenAI (GPT):**
```bash
OPENAI_API_KEY=sk-... node examples/hello-agent-openai/dist/index.js
# Optional: OPENAI_BASE_URL=... OPENAI_MODEL=gpt-4o OPENAI_PROTOCOL=chat|responses
```

**Any OpenAI-compatible service (Ollama, vLLM, llama.cpp, LM Studio, OpenRouter, your own):**
```bash
EMERGE_LLM_BASE_URL=http://localhost:11434/v1 EMERGE_LLM_MODEL=llama3.2 \
  node examples/hello-agent-custom-url/dist/index.js
# Optional: EMERGE_LLM_API_KEY=... EMERGE_LLM_PROTOCOL=chat|responses
```

## Status

| Module | Purpose | State |
|---|---|---|
| `@emerge/kernel` | Contracts, scheduler, message bus, lifecycle, guards; inbox unification (A); Postmortem auto-invoke (C) | shipped (M0–M3c1) |
| `@emerge/providers/mock` | Scripted mock provider for testing/demos | shipped (M1) |
| `@emerge/providers/anthropic` | Anthropic Claude adapter; `baseURL` + `extraHeaders` (D3) | shipped (M1, M3c1) |
| `@emerge/providers/openai` | OpenAI adapter; chat + responses protocols; custom `baseURL` (D1) | shipped (M3c1) |
| `@emerge/providers/openai-compat` | Thin wrapper for any OpenAI-compatible service (D2) | shipped (M3c1) |
| `@emerge/agents` | Topology helpers (supervisor/pool/pipeline); LLM aggregation in supervisorWorker (B) | shipped (M3a, M3c1) |
| `@emerge/artifacts-local-fs` | Local-filesystem artifact store | shipped (M3a) |
| `@emerge/workspaces-git-worktree` | Git worktree + scoped-tmpdir workspace managers | shipped (M3a) |
| `@emerge/memory/*` | Episodic + semantic + working + pinned; associative recall | planned (M5) |
| `@emerge/tools` | Tool registry, MCP integration | shipped (M1) |
| `@emerge/surveillance` | Capability probing, adaptive decomposition | shipped (M2) |
| `@emerge/sandbox-inproc` | In-process sandbox with permission policy | shipped (M1) |
| `@emerge/telemetry-jsonl` | JSONL-backed telemetry | shipped (M1) |
| `@emerge/persistence/*` | Durable task graphs, checkpoints, resume | planned (M4) |
| `@emerge/modes` | Built-in mode definitions + ModeRegistry impl | shipped (M1) |
| `@emerge/replay` | Session recorder + replayer | shipped (M1) |
| `@emerge/experience/*` | Postmortem + experience library + bundles | in-kernel (M3c1), standalone package planned (M5) |
| `@emerge/cli` | `emerge run/replay/probe/status` + JSONL schema + OTel emission | planned (M3c2) |
| `@emerge/telemetry-otel` | OpenTelemetry exporter — Phoenix / Langfuse / any OTel sink | planned (M3c2) |
| `@emerge/tui` | Ink+React live monitor: topology / verdicts / cost / replay scrubber | planned (M3d) |
| `@emerge/dashboard` | Vite+React+WebSocket web monitor: topology graph / verdict feed / replay | planned (M3d) |

> **M3c1 note:** Inbox unification (AgentRunner consumes `request` envelopes addressed to it), supervisor LLM aggregation in `supervisorWorker`, `Kernel.mountPostmortem()` + auto-invoke in `endSession()`, OpenAI/OpenAI-compat providers, and three real-model demos shipped in this milestone.
>
> **M3a fix-up note:** Adjudicator-gated session completion and pinned-context recall went live in the M3a fix-up commit. Mid-flight quota grant (bus-routed, applied atomically between preStep calls) and terminal-result envelopes on all failure/abort paths were also wired in the same pass.

The full roadmap with per-milestone deliverables and acceptance criteria lives at [docs/design/roadmap.md](./docs/design/roadmap.md).

## Getting started

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

**Run all demos (skip-mode when env vars are unset):**
```bash
for demo in hello-agent hello-mcp cycle-guard-trip eval-probes replay-smoke \
            topology-supervisor-worker weak-model-decomposition \
            hello-agent-anthropic hello-agent-openai hello-agent-custom-url; do
  node examples/$demo/dist/index.js
done
```

## Contributing

The project is in its founding phase. The fastest way to contribute is to
read the contracts in `packages/kernel/src/contracts/` and open issues that
challenge their shape — before implementations harden them.

## License

[MIT](./LICENSE)
