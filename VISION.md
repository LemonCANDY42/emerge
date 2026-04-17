# Vision

> A harness should make a weaker model competent and a stronger model devastating.

## The problem

Today's agent harnesses ship with three implicit assumptions:

1. **One model.** The harness is built around the capabilities of a single
   frontier model. When the model changes — gets weaker, hits a context
   ceiling, or is swapped for a cheaper one — the harness's behavior degrades
   silently.
2. **One agent.** Sub-agents exist, but as a tool that gets invoked. Real
   multi-agent topologies (supervisor / worker / critic, with shared bus and
   distinct contexts) are second-class.
3. **One shot.** State lives in the process. Background work is a kludge.
   Resume across sessions is best-effort.

The result is harnesses that are tightly coupled to a single vendor's strongest
model and that fall over the moment any of these assumptions break.

## What we want

`emerge` is built for a world where:

- The model is a *runtime variable*, not a build-time constant.
- The harness can *measure* what the current model can do and adapt the task
  graph until each step fits the model in front of it.
- Multi-agent topologies are first-class. Spawning a sub-agent is as cheap as
  calling a function.
- Long-running, durable, resumable tasks are the default — not the exception.
- Token cost is a design constraint, surfaced everywhere.
- Polished UX is a feature of the harness itself, not something the user app
  has to rebuild.

## Principles

### 0. The contract is never forgotten
A dedicated **Custodian** agent holds the master work contract verbatim
through a pinned-context discipline that survives every compression
strategy. A separate **Adjudicator** evaluates outputs against acceptance
criteria; only an aligned verdict marks the session complete (unless
explicitly trusted). Children negotiate quota mid-flight; the kernel
applies cap mutations atomically.

### 1. The model is observed, not assumed
The kernel runs continuous capability checks against the active model on the
real task — not benchmark suites. When confidence drops, the surveillance
layer triggers a *plan revision*: smaller steps, more scaffolding, a stronger
delegate, or all three. A weaker model can complete a larger task because the
harness shrinks each step until the model can handle it — and stacks those
steps behind opaque interfaces so the model never sees the full ladder.

### 2. Contracts before implementations
Every layer (provider, memory, tool, sandbox, surveillance, telemetry) is a
small, stable contract. Implementations are swappable. Fork modules, not the
harness.

### 3. Token frugality is structural, not stylistic
Every primitive accounts for tokens:
- Skills load on demand via tool-result, never via system prompt.
- Tool results return *handles* by default; raw payloads are pulled lazily.
- Context updates are diffs, not snapshots, where the underlying state allows.
- Compression runs in layers (verbatim → summarized → semantic-indexed →
  archived), with deterministic recall paths between them.

### 4. Recall is associative, not positional
Memory is retrieved by relevance — semantic, structural, temporal — not by
recency window or full-text grep. The recall path is observable and
debuggable; "why did you remember this?" is a first-class question.

### 5. Multi-agent is the floor, not the ceiling
The kernel has agents, supervisors, and a message bus. Solo-agent setups are
the trivial case of a one-node topology — not the privileged path.

### 6. Durability over performance
A task that survives a process crash is more valuable than one that runs 10%
faster. State is persisted. Sessions resume. Background work is a primitive.

### 7. Pluggable, but opinionated
The kernel ships with strong defaults. It is opinionated about *shapes* and
agnostic about *vendors*. You can swap the provider; you cannot skip the
contract.

### 8. Elegance in the small
Borrowed from harnesses we admire: streaming output, terminal polish, smart
defaults, sane errors, fast startup. The harness should *feel* good to use.

### 9. Honest about reproducibility
We do not claim "same seed → same output." Across providers, inference
servers, and versions, that promise would be a lie. We claim something
stronger and narrower: **recorded sessions replay exactly**. Three honest
tiers — `record-replay`, `pinned`, `free`.

### 10. No never-ending loops, no denial-of-wallet
Every agent declares a `TerminationPolicy` or it does not spawn. The
scheduler enforces depth bounds, cycle detection on spawn lineage, and a
fingerprint cycle guard on tool/prompt repeats. A single retry budget
flows through provider / tool / agent layers. Cost is a budget dimension,
not a metric.

### 11. The harness gets smarter session-over-session
Every session is recorded; a postmortem analyzer distills `Experience`s
keyed by problem-solving approach (not topic); surveillance reads them
as priors at session start. Bundles are exportable / importable /
mergeable for community sharing.

### 12. Humans are first-class participants
Not a tool. `human.request` / `human.reply` / `human.timeout` envelopes;
async approval queue managed by the host. Modes like `plan`,
`accept-edit`, and `research` use the primitive natively.

## Non-goals

- Replacing a model. We are infrastructure, not a model.
- Hosting models. Bring your own provider.
- A single-tenant SaaS. The kernel runs on your machine, in your CI, in your
  servers.
- Replicating any specific existing harness. We learn from them; we are not
  them.

## Roadmap (rough)

1. **M0 — Contracts frozen.** All kernel contracts published, discussed,
   stable enough to build against in parallel.
2. **M1 — Single-agent loop.** Kernel + one provider + minimal tool set +
   in-memory state. End-to-end "hello world" agent.
3. **M2 — Surveillance v1.** Capability probes + adaptive decomposition
   triggered on observed degradation.
4. **M3 — Multi-agent + bus.** Supervisor/worker, message-passing,
   sub-agent context isolation.
5. **M4 — Persistence + resume.** Durable task graphs, checkpointing.
6. **M5 — Memory.** Associative recall with layered compression.
7. **M6 — TUI.** First-class terminal UX.

Each milestone is a working harness — just with fewer features than the next.
