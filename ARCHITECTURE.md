# Architecture

## One-paragraph summary

`emerge` is a small, opinionated **kernel** that runs an agent loop and
delegates everything interesting — model calls, memory, tools, sandboxing,
telemetry, capability assessment — to **modules** behind stable contracts.
Agents are first-class runtime entities (with their own context, budget, and
capability envelope) that communicate over a **bus**. The kernel observes
the active model continuously and asks the **surveillance** module whether
the current task fits; if not, it triggers re-planning with finer
decomposition or escalation.

## Layers

```
            ┌──────────────────────────────────────────────────┐
            │                       cli                        │  user surface
            └──────────────────────────────────────────────────┘
            ┌──────────────────────────────────────────────────┐
            │                     agents                       │  topology
            │   supervisor · worker · critic · sub-agent       │
            └──────────────────────────────────────────────────┘
            ┌──────────────────────────────────────────────────┐
            │                     kernel                       │  the loop
            │   scheduler · bus · lifecycle · budgets          │
            └──────────────────────────────────────────────────┘
   ┌────────┬────────┬────────┬────────┬────────────┬─────────┐
   │provider│ memory │ tools  │sandbox │surveillance│telemetry│  modules
   └────────┴────────┴────────┴────────┴────────────┴─────────┘
```

Every box below `kernel` is a **contract** in `@lwrf42/emerge-kernel/contracts`,
implemented in its own package. Every box above is built *on* those contracts.

## The kernel

The kernel owns:

- **The loop.** `perceive → decide → act → observe`. Drives one or many
  agents.
- **The bus.** Typed messages between agents, modules, and the host.
- **The scheduler.** Concurrency, priorities, fair budgeting across agents.
- **Lifecycle.** Spawn, suspend, resume, checkpoint, terminate.
- **Budgets.** Tokens, wall time, tool calls, $$ — accounted per agent and
  per task.

The kernel does *not* own: how a model is called, how memory is retrieved,
how a tool is executed, or how a process is sandboxed. Those are modules.

## Contracts (kernel-defined)

### Provider
A model adapter. Streams tokens, exposes tool-use, declares capabilities
(context window, native tool support, vision, latency tier, $/Mtok). Multiple
providers coexist; the kernel routes per-call.

### Agent
A configured combination of: provider, prompt template, tool subset, memory
view, budget, and supervisor relationship. Agents are *values*, not
inheritable classes.

### Tool
A schema + handler + permission descriptor. Tools register with the kernel,
not with an agent — agents are granted *subsets* of the registry.

### Memory
Three tiers, one interface:
- **Working** — the live messages window for an agent.
- **Episodic** — the durable trace of what happened.
- **Semantic** — extracted, indexed, and recalled by relevance.
Recall is a single `recall(query, scope, budget)` call with an observable
*recall path* describing why each item came back.

### Sandbox
An execution boundary for tool side-effects (filesystem, network, processes).
Pluggable: in-process, container, microVM.

### Surveillance
The differentiator. See its own section below.

### Telemetry
Tracing, token accounting, eval hooks. Every kernel decision emits a span.

## Surveillance and adaptive decomposition

The surveillance module answers, on demand:

> *Can the active model accomplish step `s` with budget `b` and tools `T`,
> at acceptable confidence?*

It answers using:

- **Calibrated probes** — small, cheap tasks of known difficulty run against
  the active model on session start and on drift signals.
- **In-flight signals** — failure rate, retry rate, tool-error rate,
  self-correction loops, hallucination markers.
- **Task profile** — declared difficulty class of the current step (set by
  the planner, refined by observation).

When a step's difficulty exceeds the model's measured envelope, the kernel
fires `surveillance.suggest()`, which returns one of:

1. **Decompose** — split `s` into `[s₁, s₂, ...]` smaller steps and re-enter.
2. **Scaffold** — add scaffolding (worked examples, pre-condition checks,
   tighter tool surface) and retry.
3. **Escalate** — run the step on a stronger provider, return its output to
   the originating agent's view as opaque.
4. **Defer** — punt to a human-in-the-loop checkpoint.

Crucially, decomposition is **opaque to the inner agent**. From the inner
agent's perspective, a single tool call returned a useful result; it did not
see the orchestrator's recursive planning. This lets weaker, smaller-context
models contribute meaningfully to bigger tasks — they only ever see steps
they can hold in their head.

## Multi-agent topology

Agents are spawned by other agents (or by the host) through the kernel.
Each agent has:

- Its own *context envelope* (working memory, system prompt, tool subset).
- Its own *budget* (tokens, wall time, $).
- A *supervisor* (or `null` for root agents).
- A *bus address* for receiving messages.

Common patterns shipped as helpers — not built into the kernel:
- **Supervisor / worker** — supervisor decomposes, workers execute.
- **Critic** — runs alongside, evaluates outputs, signals revisions.
- **Pool** — N workers claim from a shared queue.

Sub-agent isolation: a sub-agent's context never bleeds into the parent's.
The parent sees a *summary* — produced by the sub-agent or by a summarizer —
through the bus.

## Memory and associative recall

Recall is a single function with an explainable trace:

```ts
recall(query: RecallQuery, scope: RecallScope, budget: TokenBudget)
  : Promise<{ items: MemoryItem[]; trace: RecallTrace }>
```

Default ranking blends:
- **Semantic similarity** to the query.
- **Structural proximity** in the project (same file, same module, same
  call-graph neighborhood).
- **Temporal proximity** (recently touched, recently relevant).
- **Causal links** (this thing was the cause/effect of that thing).

The `RecallTrace` is human-readable: "this item ranked because it scored 0.81
semantic + 0.4 structural + recent in last hour." Debuggability is a feature,
not an afterthought.

Compression runs in layers: verbatim → summary → semantic-only → archived.
Each layer has a fixed budget; promotion/demotion runs out-of-band.

## Token frugality, structurally

- **On-demand skill loading.** Skills are tool-results, not preludes.
- **Tool-result handles.** Tools return `{ handle, preview, size }`; full
  payload is fetched lazily through a `read_handle` tool.
- **Diffs over snapshots.** When the underlying state allows (file edits,
  state machines), the context shows diffs.
- **Recall budgets.** Memory respects per-call token budgets; if it can't
  fit, it returns headers and lets the agent decide what to expand.
- **Provider routing.** Cheap models for cheap steps, by default.

## Long-horizon execution

Every agent and every task is durable:

- **Task graph** persisted on transition.
- **Checkpoint** before any expensive or external action.
- **Resume** transparently after process restart.
- **Background work** is a first-class kernel concept; an agent can spawn a
  detached child and continue, receiving completion via the bus.

Storage backend is a contract — SQLite by default, with adapters for Postgres
and others.

## What this is not

- A model. Bring your own.
- A workflow engine. Workflows can be built on top, but the kernel is an
  agent loop.
- A web framework. The CLI is the first surface; servers can wrap the kernel.

## Why these choices (landscape grounding)

The contract surface and module split aren't arbitrary — they're targeted
defenses against failure modes we observed in the 2025-2026 harness
landscape. Highlights:

- **Streaming, bidirectional bus** with delta envelopes — defends against
  the "sub-agents only reachable at completion" trap that bites
  Claude-Code-style harnesses (ADR 0006). Inspired by the converged
  ACP/A2A model.
- **Tools, not nodes, are the checkpoint boundary** — defends against the
  LangGraph "lost work inside a long-running node" trap (ADR 0005).
- **Topology is a value, not a class** — defends against the
  CrewAI/AutoGen "your runtime IS the topology, no nesting allowed"
  trap (ADR 0007).
- **Per-agent TerminationPolicy + spawn-lineage cycle detection +
  fingerprint cycle guard + retry budget propagation** — defends against
  2026's dominant agent-engineering plague: infinite loops and denial-
  of-wallet attacks (ADR 0009).
- **Custodian + Adjudicator + Quota negotiation + pinned context** —
  defends against the contract-drift-as-context-compresses trap that
  haunts every long-running session (ADRs 0011, 0012, 0013, 0016).
- **Multi-strategy associative recall with explainable trace** — defends
  against the single-strategy-retrieval trap that limits Mem0/Zep/Letta
  in different ways (ADR 0004); inspired by the Hindsight pattern.
- **Replay + experience library + postmortem analyzer** — defends
  against the "every session is amnesic" trap that prevents harnesses
  from getting smarter session-over-session (ADRs 0018, 0019, 0029).
- **Modes-as-policy + permission-policy distinct from per-tool descriptor**
  — defends against the ad-hoc-permission-enforcement trap (ADRs 0020,
  0021).
- **Cost as first-class observable** — defends against the silent
  budget-bleed trap (ADR 0022).
- **Reproducibility, not determinism** — defends against the dishonest
  "same seed → same output" trap (ADR 0023).
- **Human-in-the-loop as a primitive** — defends against the
  block-on-stdin and "humans are tools" anti-patterns (ADR 0024).
- **Workspace isolation** — defends against the parallel-agents-
  trample-each-other trap (ADR 0027); borrowed from `learn-claude-code`'s
  worktree pattern.
- **Standard Schema + OTel/W3C Trace Context** — defends against the
  vendor-lock-on-validators and non-portable-observability traps
  (ADRs 0025, 0026).
- **Speculative branch-and-merge with experience write-back** — closes
  the surveillance/experience self-improving loop (ADRs 0028, 0029).

ADRs 0001-0030 in `docs/adr/` document the full list with alternatives
considered and consequences.

## Stability promises

- **Contracts first.** Contracts in `@lwrf42/emerge-kernel/contracts` are versioned
  carefully and changes are an explicit decision.
- **Modules are second.** Module APIs may change before a 1.0 of that
  module.
- **Internals are not promised.** Anything not in a contract is internal.
