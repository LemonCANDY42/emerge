# AGENTS.md — AI agent entry point for emerge

If you are an AI agent landing in this repository, start here. This file tells you how to navigate emerge, what you can safely change, and where the key contracts live.

## What this repo is

**emerge** is a TypeScript agent harness for building durable, model-aware AI agents. It treats the model itself as a runtime variable — not a build-time constant. The harness measures what the active model can do and adapts task structure to fit. Multi-agent topologies (supervisor/worker, critic, custodian/adjudicator) are first-class. Agents communicate over a streaming, bidirectional message bus. Sessions are durable and resumable.

Key concepts: **contracts** (small, stable interfaces), **surveillance** (capability probing + adaptive decomposition), **kernel** (the runtime loop), **modules** (swappable providers, memory, tools, sandbox), **topology** (supervisor/worker/pool/pipeline/etc as values, not classes).

## AI agents: read these files first

**In order:**

1. **[VISION.md](./VISION.md)** — Why emerge exists, the 12 core principles, non-goals. (5 min read; tells you what not to do.)
2. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Layers, contracts, surveillance, multi-agent, memory, long-horizon execution. (10 min read; the *why* behind every choice.)
3. **[packages/kernel/src/contracts/](./packages/kernel/src/contracts/)** — 31 TypeScript files defining every sayable thing. Start with `agent.ts`, `blueprint.ts`, `bus.ts`, `surveillance.ts`. (30 min focused read.)
4. **[docs/adr/](./docs/adr/)** — Architecture decision records 0001–0033. ADRs 0011–0012 (Custodian/Adjudicator), 0007 (topology-as-value), 0005 (tools-as-checkpoint), 0006 (streaming-bus), 0009 (cycle-guards), 0020–0021 (modes/permissions) are load-bearing. (Skim first; read fully when you hit related code.)
5. **[docs/design/roadmap.md](./docs/design/roadmap.md)** — Shipped (M0–M3c1) and next-up (M3c2–M5) features, with dependencies. Marks [planned] features you cannot use yet.
6. **[docs/usage.md](./docs/usage.md)** — SDK integration: how an external app uses emerge (mounting kernel, spawning agents, subscribing to bus).
7. **[docs/agents/index.md](./docs/agents/index.md)** — Agent type matrix and picking guidance.
8. **[docs/agents/{type}.md](./docs/agents/)** — Per-agent-type guides (research-agent, code-agent, orchestrator-agent, etc). Read the one(s) matching your use case.

## Hard rules for any change

- **Contracts in `packages/kernel/src/contracts/` are load-bearing.** Do not edit them without opening an issue or writing an ADR first. A contract change ripples to every implementation.
- **No vendor lock-in in the kernel.** Vendor-specific code lives in `packages/providers/{anthropic,openai,openai-compat,mock}`. The kernel must compile with zero provider dependencies.
- **Token cost is a design constraint.** Before adding to a hot path, justify the token impact.
- **Don't bypass surveillance.** Adaptive decomposition is the thesis. Hard-assuming a strong model defeats the whole point.
- **Branch guard:** On any change, `pnpm typecheck`, `pnpm lint`, `pnpm test` must stay green. No exceptions.
- **Prefer ADRs over comments.** Non-obvious design → write an ADR in `docs/adr/NNNN-title.md`, not a comment in code.

## Repo layout

```
emerge/
├─ VISION.md                    ← Why (read first if new)
├─ ARCHITECTURE.md              ← How (comprehensive overview)
├─ CLAUDE.md                    ← Conventions for human developers
├─ AGENTS.md                    ← YOU ARE HERE
├─ README.md                    ← Public marketing face
├─ packages/
│  ├─ kernel/
│  │  ├─ src/contracts/         ← 31 contract files (THE SOURCE OF TRUTH)
│  │  │  ├─ agent.ts            ← AgentSpec, ProviderRouting, MemoryViewSpec
│  │  │  ├─ blueprint.ts        ← AgentBlueprint, slot composition
│  │  │  ├─ bus.ts              ← BusEnvelope discriminated union (18 kinds)
│  │  │  ├─ surveillance.ts      ← Surveillance, capability probing
│  │  │  ├─ custodian.ts        ← Custodian role contract
│  │  │  ├─ adjudicator.ts       ← Adjudicator role contract
│  │  │  ├─ termination.ts      ← TerminationPolicy, cycle guards
│  │  │  ├─ [20 more...]
│  │  └─ runtime/
│  │     ├─ kernel.ts           ← Kernel facade
│  │     ├─ agent-runner.ts     ← The perceive→decide→act→observe loop
│  │     ├─ bus.ts              ← In-process bus impl
│  │     └─ [more...]
│  ├─ agents/
│  │  ├─ src/
│  │  │  ├─ topologies/
│  │  │  │  ├─ supervisor-worker.ts
│  │  │  │  ├─ worker-pool.ts
│  │  │  │  └─ pipeline.ts
│  │  │  ├─ roles/
│  │  │  │  ├─ custodian.ts     ← buildCustodian()
│  │  │  │  ├─ adjudicator.ts   ← buildAdjudicator()
│  │  │  │  └─ postmortem.ts    ← buildPostmortem()
│  │  │  └─ blueprint-registry.ts ← BlueprintRegistry validation
│  ├─ providers/
│  │  ├─ mock/                  ← MockProvider (testing, scripted)
│  │  ├─ anthropic/             ← Anthropic Claude adapter
│  │  ├─ openai/                ← OpenAI Chat + Responses API
│  │  └─ openai-compat/         ← Any OpenAI-compatible endpoint
│  ├─ surveillance/             ← CalibratedSurveillance impl
│  ├─ tools/                    ← fs.read, fs.write, tool registry
│  ├─ tools-mcp/                ← MCP client → kernel tools
│  ├─ modes/                    ← BuiltinModeRegistry, PermissionPolicy
│  ├─ memory-*                  ← SimpleMemory (M1), full suite planned (M5)
│  ├─ sandbox-inproc/           ← In-process sandbox + permission enforcement
│  ├─ replay/                   ← Session recorder + replayer
│  ├─ experience/               ← Postmortem analyzer, experience library
│  ├─ artifacts-local-fs/       ← Local filesystem artifact store
│  ├─ workspaces-git-worktree/  ← Git worktree workspace manager
│  ├─ telemetry-jsonl/          ← JSONL event writer
│  └─ [12 total packages]
├─ examples/
│  ├─ hello-agent/              ← Basic loop with MockProvider
│  ├─ hello-agent-anthropic/    ← Real Anthropic provider (env var gated)
│  ├─ hello-agent-openai/       ← Real OpenAI provider (env var gated)
│  ├─ hello-agent-custom-url/   ← Any OpenAI-compatible endpoint
│  ├─ topology-supervisor-worker/ ← Custodian + Adjudicator + quota flow
│  ├─ eval-probes/              ← runProbesAsync() demo
│  ├─ weak-model-decomposition/ ← Surveillance in action
│  ├─ cycle-guard-trip/         ← Cycle guard demo
│  ├─ hello-mcp/                ← MCP tool integration
│  └─ replay-smoke/             ← Session replay demo
├─ docs/
│  ├─ design/
│  │  ├─ roadmap.md             ← Shipped + planned, by milestone
│  │  └─ terminal-bench-integration-plan.md ← Leaderboard harness
│  ├─ adr/
│  │  ├─ 0001-typescript-monorepo.md
│  │  ├─ 0005-tools-as-checkpoint-boundary.md
│  │  ├─ 0006-streaming-bus-envelope.md
│  │  ├─ 0007-topology-as-value.md
│  │  ├─ 0009-loop-and-recursion-safeguards.md
│  │  ├─ 0011-contract-custodian-as-kernel-role.md
│  │  ├─ 0012-compliance-adjudicator.md
│  │  ├─ [...0033]               ← 33 total ADRs
│  │  └─ README.md              ← How to read ADRs
│  ├─ install.md                ← Prerequisites, install, verify, run
│  ├─ usage.md                  ← SDK usage: mount → spawn → run
│  ├─ api.md                    ← API reference (contracts, no auto-gen)
│  └─ agents/
│     ├─ index.md               ← Agent type matrix + decision flowchart
│     ├─ research-agent.md
│     ├─ code-agent.md
│     ├─ data-agent.md
│     ├─ orchestrator-agent.md
│     ├─ critic-agent.md
│     ├─ custodian-agent.md
│     └─ postmortem-agent.md
└─ .well-known/
   └─ ai-instructions.md        ← Machine discovery
```

## Where to look for what

| I need to ... | Look at | Why |
|---|---|---|
| Understand the domain | VISION.md + ARCHITECTURE.md | First principles |
| Find a contract definition | `packages/kernel/src/contracts/agent.ts`, etc. | Source of truth |
| Understand a design choice | `docs/adr/NNNN-*.md` | Alternatives + consequences documented |
| See how agents work in practice | `examples/hello-agent/src/index.ts` | Working code |
| Set up topologies (supervisor/worker) | `packages/agents/src/topologies/supervisor-worker.ts` + `examples/topology-supervisor-worker/` | Wired demo |
| Write a custom agent type | `docs/agents/research-agent.md` (template) | Copy and adapt |
| Understand capability probing | `packages/surveillance/src/` + `examples/eval-probes/` | The differentiator |
| Integrate a real model | `docs/usage.md` + `examples/hello-agent-{anthropic,openai,custom-url}` | End-to-end |
| Debug a session | `docs/usage.md` (record/replay) + `examples/replay-smoke/` | Reproducible traces |
| Add a new permission mode | `packages/modes/src/` + ADR 0020 | Pluggable policy |
| Bridge MCP tools | `packages/tools-mcp/src/` + ADR 0031 | Per-provider schema adapter |
| Measure model costs | `packages/kernel/src/contracts/cost.ts` + any example | Ledger per agent/task |
| Design a provider adapter | `packages/providers/mock/src/` (smallest) or `packages/providers/anthropic/src/` | Model abstraction |

## How to run / test

**Install and build:**
```bash
pnpm install
pnpm build
```

**Type check, lint, test (required green on any change):**
```bash
pnpm typecheck  # tsc across all packages
pnpm lint       # eslint
pnpm test       # vitest (115 tests across 11 files)
```

**Run all 10 demos (safe in CI; skip if env var unset):**
```bash
for demo in hello-agent hello-mcp cycle-guard-trip eval-probes replay-smoke \
            topology-supervisor-worker weak-model-decomposition \
            hello-agent-anthropic hello-agent-openai hello-agent-custom-url; do
  node examples/$demo/dist/index.js
done
```

**Try a real model (requires env var):**
```bash
ANTHROPIC_API_KEY=sk-ant-... node examples/hello-agent-anthropic/dist/index.js
# or
OPENAI_API_KEY=sk-... node examples/hello-agent-openai/dist/index.js
# or
EMERGE_LLM_BASE_URL=http://localhost:11434/v1 EMERGE_LLM_MODEL=llama3.2 \
  node examples/hello-agent-custom-url/dist/index.js
```

## Permissions checklist

What counts as **destructive** and needs extra care:

- **Editing `packages/kernel/src/contracts/*.ts`:** Load-bearing. Stop and discuss.
- **Adding `tokensIn`/`tokensOut` to a hot path:** Costs accumulate. Measure first.
- **Changing provider routing logic in `packages/kernel/src/runtime/agent-runner.ts`:** Affects task assignment. Test comprehensively.
- **Reordering `BusEnvelope` discriminated union in `packages/kernel/src/contracts/bus.ts`:** Breaks serialization. Versioned ADR required.
- **Removing or renaming a role helper in `packages/agents/src/roles/`:** Public API surface. Deprecate first in an ADR.
- **Modifying surveillance scoring in `packages/surveillance/src/`:** Affects decomposition decisions. Benchmark before/after.

What's safe to change:

- Examples (`examples/*/src/`): test harness only, no impact on kernel.
- Documentation (`docs/`): never breaks the build.
- Tests (`*.test.ts`): expanding coverage is always safe; removing tests requires justification.
- Telemetry messages: can be extended without breaking replays.

## Reporting bugs / opening issues

1. Is the problem reproducible in an existing demo, or only in your custom code?
2. Do you have a minimal example?
3. Does the problem violate a contract, or is it usage?
4. Check ADRs for design rationale before proposing a change.

Include: observed behavior, expected behavior, steps to reproduce, terminal output, relevant contract file references.

## Final checklist

Before pushing a change:

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] No new speculative files (add when second use-case appears)
- [ ] Comments explain *why*, not *what* — the code says what
- [ ] Contract changes have an ADR or open issue
- [ ] Examples still run without API keys (skip gracefully)

Good luck. Read the code. The contracts speak the truth.
