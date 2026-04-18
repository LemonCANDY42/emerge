# Agent Types — Selection Guide

Choose the right agent type for your task. This guide covers two viewpoints: **emerge-as-host** (building agents that run inside emerge) and **emerge-as-client** (embedding emerge in your app).

## Two viewpoints

### emerge-as-host
You are *configuring* agents that run inside the harness. Your code writes `AgentSpec` and `AgentBlueprint`. This is **agent type selection**: you pick a pre-built role (supervisor, worker, critic, custodian, etc.) and customize it. See individual type guides below.

**When to use:** You want the harness to manage agent topology, capabilities, and lifecycle. You focus on system prompt + tool selection.

**Files:**
- `packages/agents/src/` (role helpers + topology builders)
- `docs/agents/{type}.md` (per-type detailed guides)

### emerge-as-client
You are *embedding* emerge in your own application. Your code imports `Kernel`, mounts providers, spawns agents programmatically. You control when agents run, what data they see, and how to interpret results. This is **SDK integration**: you own the outer loop.

**When to use:** You're building a larger system (workflow orchestrator, web service, CLI) that needs agent capabilities as a component.

**Files:**
- [docs/usage.md](../usage.md) (SDK integration guide)
- `examples/` (10 working demos)

| Viewpoint | You write | You control | You see |
|---|---|---|---|
| **emerge-as-host** | AgentSpec, system prompts, tool selections | Agent role + capabilities, budget, surveillance | Verdicts, cost, agent state |
| **emerge-as-client** | Kernel setup, provider routing, session lifecycle | When agents spawn/run/terminate, what bus messages mean | Raw envelopes, aggregated results, error handling |

**Both are needed together.** The client embeds the kernel; the kernel runs your specified agents.

## Agent type matrix

Select by task type. Each links to a detailed guide with recommended config, code examples, and common pitfalls.

| Type | Use when | Recommended provider tier | Surveillance | Typical tools | Guide |
|---|---|---|---|---|---|
| **Research** | Read-heavy, web/MCP fetching, no writes | Standard (Haiku-like) | "passive" | fs.read, web.fetch, memory.recall | [research-agent.md](./research-agent.md) |
| **Code** | Implement, refactor, fix bugs, run tests | Strong (Sonnet/GPT-4) | "active" | fs.read, fs.write, shell.exec, git | [code-agent.md](./code-agent.md) |
| **Data** | Transform, aggregate, query, analyze | Standard | "passive" | sql.query, csv.read, memory.recall | [data-agent.md](./data-agent.md) |
| **Orchestrator** (supervisor) | Decompose goals, route to workers | Standard (meta-reasoning) | "off" or "passive" | bus.send, quota.request, memory.recall | [orchestrator-agent.md](./orchestrator-agent.md) |
| **Critic** (adjudicator) | Evaluate outputs, gate completion | Strong (evaluator) | "off" | none (reads contract + outputs) | [critic-agent.md](./critic-agent.md) |
| **Custodian** | Hold contract, manage quota, store artifacts | Mock (no LLM calls) | "off" | none (mediation only) | [custodian-agent.md](./custodian-agent.md) |
| **Postmortem** | Analyze sessions, extract lessons | Standard | "off" | none (batch analysis) | [postmortem-agent.md](./postmortem-agent.md) |

## Picking the right type: decision flowchart

```
┌─ What is the task?
│
├─ "Read and summarize documents"
│  └─> RESEARCH AGENT (read-only, web/file fetching)
│
├─ "Write code, fix bugs, run tests"
│  └─> CODE AGENT (read + write, shell, git)
│
├─ "Transform data, aggregate tables"
│  └─> DATA AGENT (SQL/CSV, no web)
│
├─ "Break big goal into sub-tasks, coordinate workers"
│  └─> ORCHESTRATOR AGENT (supervisor + worker pool)
│      └─> Workers can be Research, Code, or Data agents
│
├─ "Evaluate outputs against acceptance criteria"
│  └─> CRITIC AGENT (adjudicator, gated completion)
│
├─ "Keep the contract/goal from drifting as context compresses"
│  └─> CUSTODIAN AGENT (pinned memory, quota ledger)
│
└─ "Extract lessons from a session for future re-use"
   └─> POSTMORTEM AGENT (batch analysis, no live loop)
```

## Typical topology patterns

### Solo agent
One agent, no topology:
```typescript
const agent = { id: "solo", role: "researcher", ... };
await kernel.spawn(agent);
```
Use for: simple tasks that fit in one agent's context.

### Supervisor + N workers
One supervisor splits work, N workers execute in parallel:
```typescript
const { run } = supervisorWorker({
  supervisor: supervisorSpec,
  workers: [worker1, worker2, worker3],
  dispatch: "parallel",
});
```
Use for: tasks that decompose into independent subtasks (research → 3 papers, code → 3 modules).

### Pipeline
Agent A's output → Agent B's input → Agent C's output:
```typescript
const { run } = pipeline({
  agents: [dataLoaderAgent, transformAgent, writerAgent],
});
```
Use for: sequential stages (load data → transform → format → write).

### Pool
M workers claim from a shared queue (elastic, good for batch work):
```typescript
const { run } = workerPool({
  workers: [worker1, worker2, worker3],
  queueSize: 100,
});
```
Use for: processing many items (document batch, test suite, bulk migration).

### With Custodian + Adjudicator
Add contract enforcement to any topology:
```typescript
const custodian = buildCustodian({ id: "custodian", contract, quotaPolicy });
const adjudicator = buildAdjudicator({ id: "adjudicator", contract, evaluate });

await kernel.spawn(custodian.spec);
await kernel.spawn(adjudicator.spec);
// Then spawn your supervisor/workers...
```
Use for: high-stakes work where contract drift or self-grading bias is a risk.

## Config defaults by type

These are **recommendations**, not rules. Adjust per your task.

| Field | Research | Code | Data | Supervisor | Critic | Custodian |
|---|---|---|---|---|---|---|
| `provider.latencyTier` | "interactive" | "interactive" | "batch" | "interactive" | "interactive" | mock |
| `surveillance` | "passive" | "active" | "passive" | "off" | "off" | "off" |
| `maxIterations` | 10 | 20 | 5 | 3 | 1 | 0 (no loop) |
| `toolsAllowed` | fs.read, web.* | fs.*, shell.*, git | sql.*, csv.* | quota, bus, memory | none | artifact, memory |
| `memoryView.inheritFromSupervisor` | true | true | true | false | true | true |

## Common pitfalls

1. **Picking Code Agent for data transformation** → Use Data Agent (better for SQL). Code Agent assumes filesystem + testing.
2. **No Adjudicator, then agent self-marks "done"** → Add Adjudicator. The producer is the worst judge of its output.
3. **Surveillance off for weak models** → Turn on "active". The harness adapts; the model doesn't have to be strong.
4. **Supervisor with 10+ workers** → Use Worker Pool instead. Supervisor/worker is for small topologies (2–5 workers).
5. **Custodian without memory** → Mount a shared Memory in KernelConfig.roles. Pinned items need a write target.

## What's shipped vs. planned

**Shipped (M3c1):**
- All 7 agent types (research, code, data, orchestrator, critic, custodian, postmortem)
- Supervisor/worker, worker-pool, pipeline topologies
- Contract Custodian + Adjudicator role helpers
- Postmortem analyzer + experience ingest

**Planned (M3c2–M5):**
- LLM-driven adjudicator (custom evaluation logic via agent, not just JS functions) [planned: M4]
- Speculative branch-and-merge topology (parallel experiments + best-of selection) [planned: M5]
- Mesh, tree, debate topology builders [planned: M5]
- Per-agent tool projections (truncate, redact, cap results per tool) [shipped: M3b via projections field]
- Durable memory (SQLite-backed episodic + semantic recall) [planned: M5]
- Experience library at scale (similarity-based matching, merge optimization) [planned: M5]

## Next steps

1. Read [docs/usage.md](../usage.md) to understand SDK integration.
2. Pick a type from the matrix above.
3. Read the detailed guide for that type (e.g., [research-agent.md](./research-agent.md)).
4. Copy the recommended blueprint and customize.
5. See [examples/](../../examples/) for working code.

## References

- VISION.md: core principles
- ARCHITECTURE.md: layer design
- [docs/design/roadmap.md](../design/roadmap.md): shipped vs. planned
- [docs/adr/0007-topology-as-value.md](../adr/0007-topology-as-value.md): why topology is data, not code
- [docs/adr/0011-contract-custodian-as-kernel-role.md](../adr/0011-contract-custodian-as-kernel-role.md): custodian pattern
- [docs/adr/0012-compliance-adjudicator.md](../adr/0012-compliance-adjudicator.md): adjudicator pattern
