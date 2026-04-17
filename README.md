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

## Status

| Module | Purpose | State |
|---|---|---|
| `@emerge/kernel` | Contracts, scheduler, message bus, lifecycle, guards | shipped (M0–M3a) |
| `@emerge/providers/mock` | Scripted mock provider for testing/demos | shipped (M1) |
| `@emerge/providers/anthropic` | Anthropic Claude adapter | shipped (M1) |
| `@emerge/agents` | Topology helpers + Custodian/Adjudicator/Postmortem roles | shipped (M3a) |
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
| `@emerge/experience/*` | Postmortem + experience library + bundles | planned (M5) |
| `@emerge/cli` | Terminal UX (TUI) | planned (M6) |

## Getting started

> Not yet runnable. The first milestone is freezing the kernel contracts in
> `packages/kernel/src/contracts/` so independent implementations can begin.

```bash
pnpm install
pnpm typecheck
```

## Contributing

The project is in its founding phase. The fastest way to contribute is to
read the contracts in `packages/kernel/src/contracts/` and open issues that
challenge their shape — before implementations harden them.

## License

[MIT](./LICENSE)
