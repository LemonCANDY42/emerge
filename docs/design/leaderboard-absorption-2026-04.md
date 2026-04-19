# Terminal-Bench 2.0 — Second-pass absorption plan (2026-04)

A focused second-pass on the TB 2.0 leaderboard top frameworks, finding
what we missed in the M3b first-pass and what's emerged since. Sources
cited inline; keep this file updated as the leaderboard moves.

## Snapshot — current top 10 (April 2026)

| Rank | Agent | Model | Score | Notes |
|---|---|---|---|---|
| 1 | Claude Mythos Preview | Anthropic Mythos | 82.0% | NEW. Bare Harbor harness, no scaffolding. 92.1% under 4-hour timeout. |
| 2 | ForgeCode | GPT-5.4 | 81.8% ±2.0 | M3b deep-dive subject. |
| 3 | ForgeCode | Claude Opus 4.6 | 81.8% ±1.7 | Same scaffold, different model. |
| 4 | TongAgents | Gemini 3.1 Pro | 80.2% ±2.6 | Closed source. |
| 5 | SageAgent (OpenSage) | GPT-5.3-Codex | 78.4% ±2.2 | NEW since M3b. Academic. |
| 6 | ForgeCode | Gemini 3.1 Pro | 78.4% ±1.8 | |
| 7 | Droid (Factory) | GPT-5.3-Codex | 77.3% ±2.2 | |
| 8 | Capy | Claude Opus 4.6 | 75.3% ±2.4 | |
| 9 | Simple Codex | GPT-5.3-Codex | 75.1% ±2.4 | OpenAI's own. |
| 10 | Terminus-KIRA (KRAFTON) | Gemini 3.1 Pro | 74.8% ±2.6 | **Open source** — best extractable architecture. |

**Headline change:** Bare Mythos at 82% means the un-engineered ceiling
for frontier models has caught up to ForgeCode's hand-engineered scaffold.
But for non-frontier models the **same-model/different-agent spread is
still 16+ points** (ForgeCode+Opus4.6 at 81.8% vs bare Opus4.6 at 65.4%).
Harness quality remains the primary variable for any model that isn't
the very latest frontier. emerge's positioning is intact.

Sources: [tbench.ai](https://www.tbench.ai/leaderboard/terminal-bench/2.0),
[morphllm.com](https://www.morphllm.com/terminal-bench-2),
[benchlm.ai](https://benchlm.ai/benchmarks/terminalBench2).

## What M3b absorbed (recap)

From the M3b first-pass research, three table-stakes were folded in:
- Per-provider JSON schema adapter (`required`-hoist, flatten,
  format-strip) — ADR 0031.
- Enforced post-step verification (Adjudicator hook) — ADR 0032.
- Truncation-aware tool results — ADR 0033.

## What M3b missed — by framework

### ForgeCode (rank 2-3)
Sources: [Part 1](https://forgecode.dev/blog/benchmarks-dont-matter/),
[Part 2](https://forgecode.dev/blog/gpt-5-4-agent-improvements/),
[github.com/antinomyhq/forgecode](https://github.com/antinomyhq/forgecode).

Five-layer runtime ForgeCode publishes. emerge covers 4-5 partially:

| ForgeCode layer | emerge equivalent | Gap |
|---|---|---|
| 1. Semantic entry-point discovery | `@lwrf42/emerge-surveillance` probes are capability-focused, not file-system semantic | medium-large |
| 2. Dynamic skill loading by task profile | Skills concept in roadmap, not shipped | medium (M3c2+) |
| 3. **Pre-dispatch tool-call correction layer** | Schema validation at registration; no runtime correction | **medium** (M3c2 candidate) |
| 4. todo_write enforcement | Custodian/Adjudicator contracts exist, kernel-level gate missing | **small** (M3c2 candidate) |
| 5. Reasoning budget control by turn count | Provider abstraction allows it; not implemented | small (M3d candidate) |

ForgeCode's biggest single change for GPT-5.4 was **field reordering +
flattening** (M3b absorbed) plus the **enforced verification skill** (gap
3 above). For Opus 4.6 the gain came mostly from removing forced
intervention — Anthropic models read between the lines, GPT models read
the lines.

### Terminus-KIRA (rank 10, fully open source)
Sources: [krafton-ai blog](https://krafton-ai.github.io/blog/terminus_kira_en/),
[github.com/krafton-ai/KIRA](https://github.com/krafton-ai/KIRA/blob/main/terminus_kira/terminus_kira.py).

Most extractable architecture in the top 10. Specific patterns we
should consider:

- **Marker-based polling for early command completion.** Each command
  appends `__CMDEND__<seq>__` echo marker. Harness polls tmux every
  500 ms, exits early on marker. Direct wall-clock recovery on TB 2.0's
  time-based scoring.
- **Structured plan field inside the tool call.** `execute_commands`
  schema includes `analysis` and `plan` as required string fields.
  Planning lives co-located with action, not in a separate tool.
- **Smart double-confirmation verifier.** Three-perspective checklist
  (requirements / edge cases / multi-perspective QA) fired via a
  `task_complete` tool that the runtime intercepts to inject the
  verifier prompt. Two-step commit pattern.
- **Reactive context overflow unwinding.** `_unwind_messages_to_free_tokens()`
  targets freeing 4000 tokens; reactive at overflow, not proactive.
  emerge's pinned-context discipline is more sophisticated but this is
  the minimum-viable comparison.
- **Anthropic prompt caching on recent messages** (provider-level
  optimization).

KRAFTON's blog states **native tool calling alone gave +11.5 points for
Opus 4.6 vs ICL/XML parsing** — that's exactly the M3b schema-adapter
absorption.

### OpenSage (rank 5, academic, NEW since M3b)
Sources: [arXiv 2602.16891](https://arxiv.org/abs/2602.16891),
[opensage-agent.ai](https://www.opensage-agent.ai/).

Three pillars:

1. **Self-generating agent topology at runtime** (vertical /
   horizontal). Removing vertical drops 78% → ~65% with summarization
   events climbing. **But OpenSage disabled this for the TB 2.0
   submission** (single-agent variant) due to TB's resource constraints,
   so the dynamic-topology advantage is NOT what drove its 78.4%.
2. **Dynamic tool synthesis** — agents author their own Python /
   Bash tools, validate, register live. Most radical idea in the top
   10. Also disabled for the TB 2.0 submission. Flag for M5/Beyond,
   not now.
3. **Hierarchical graph-based long-term memory (Neo4j)** with raw
   tool outputs preserved in reference nodes. Directly addresses the
   compression/loss tradeoff that emerge's planned M5 memory will face.

### Droid (Factory, rank 7)
Sources: [factory.ai/news/terminal-bench](https://factory.ai/news/terminal-bench).

- **Fast-fail timeout strategy** — short defaults, opt into longer
  timeouts only when task profile demands. Counterintuitive but matches
  TB 2.0's time-based scoring.
- **In-context plan with step-crossing** — a tool call crosses off
  completed step + marks next as in-progress at the position in
  context where LLMs pay most attention (the end). Sophisticated
  todo_write variant.
- **Background execution primitive** — structured tool to start a
  process, get a handle, continue working. Essential for tasks
  requiring server startup, compilation monitoring, training runs.
- **Strict tool-set minimalism** — Droid measured "complex tool
  schemas exponentially increased error rates." Aligns with KIRA's
  findings.

### Recent disclosures since M3b

- **OpenDev** (arXiv 2603.05344, March 2026): event-driven system
  reminders to counteract attention decay; five-role model routing
  with fallback chains; dual-agent plan-then-execute with **schema
  filtering at plan-agent build time** (planner never sees tools
  outside its allowlist).
- **Terminator-1** (X post,
  [Hanchen Li](https://x.com/lihanc02/status/2042302344906621289)):
  claims 95%+ on both SWE-bench Verified and TB 2.0 with "well-designed
  harness." No public details. Treat as unverified.

## emerge unique-positioning sanity check

| emerge differentiator | Top-10 equivalent? | Risk |
|---|---|---|
| Surveillance + adaptive decomposition | OpenDev has task-profile routing; OpenSage has dynamic topology. Neither is probe-driven. | Low |
| Custodian/Adjudicator with kernel-aware verdict gating | ForgeCode runtime-enforced verification gate. KIRA two-step `task_complete` commit. | **Medium** — gate enforcement gap (see Priority 2 below) |
| Bus-routed quota negotiation | None | Unique |
| AgentBlueprint typed slot composition | None | Unique |
| Pinned-context discipline | OpenSage uses graph reference nodes (different mechanism, similar intent). | Low |
| Replay-grounded experience library (approach-keyed) | OpenDev "playbook of learned strategies that evolve based on feedback." | **Medium** — closest competitor; monitor arXiv 2603.05344 |
| Reproducibility tiers (record-replay / pinned / free) | None | Unique |
| AgentRunner inbox unification | None | Unique |
| git-worktree workspace isolation | Not unique at concept level (workspace isolation is table stakes); git-worktree mechanism is distinct from container approaches. | Low |

## Concrete absorption proposals — ranked

| # | Proposal | Cost | Impact | Slot |
|---|---|---|---|---|
| 1 | **Pre-dispatch tool-call correction layer** between model output and `@lwrf42/emerge-kernel` dispatch. Heuristic + lightweight static analysis: type coercion, missing optional defaults, string-escape fixes. Log unfixable; escalate. ForgeCode attributes consistent cross-model perf to this. | small-med | **high** | M3c2 |
| 2 | **Kernel-enforced verification gate before task exit.** Kernel refuses `task_complete` until the Adjudicator verification skill has been called in the current session. Verification prompt: "what evidence proves this objective is complete?" Elevated reasoning budget. ForgeCode's most impactful single change for GPT-class models. emerge's Adjudicator contract already accommodates this; need session-scoped boolean gate in kernel lifecycle. | small | **high** (non-Anthropic) | M3c2 |
| 3 | **Marker-based early command completion** in sandbox. Append echo sentinel after each command; poll for it; exit wait early when seen; filter sentinel from LLM-visible output. Direct wall-clock recovery on TB 2.0 scoring. KIRA reference impl available. | small | medium | M3c2 |
| 4 | **Progressive reasoning budget by turn count.** Provider-adapter hook: turns 1-10 high thinking, 11+ low, reset on verifier invocation. No contract change. | small | medium | M3d |
| 5 | **Background execution primitive** in `@lwrf42/emerge-tools` / sandbox. Spawn detached process, get handle, continue working. Unlocks server-startup / compilation / training-monitor TB 2.0 tasks. | medium | medium | M3d |
| 6 | **Event-driven system reminders** (attention-decay injection). OpenDev-style: targeted guidance injection at decision points, not static system prompt. Triggered by turn count, tool-error spike, idle. Operationalizes surveillance into mid-task correction. | medium | medium | M4 |
| 7 | **Hierarchical reference-node memory for tool outputs.** OpenSage-inspired: full output in reference node, summary in active context, retrieve on demand. Aligns pinned-context discipline with long-output survival. | large | high (SWE-bench Pro) | M5 |

## Decision

Fold proposals **1, 2, 3** into M3c2 (alongside the already-planned CLI
+ JSONL schema + OTel emission). They share an implementation surface
with the runtime + sandbox layer, and all three have low cost / high
TB 2.0 impact. Each lands as an ADR.

Proposals **4, 5** queue for M3d (TUI + monitor) since they affect
session-level UX visible in dashboards.

Proposal **6** queues for M4 (persistence) where event-driven reminders
can be persisted in the recorded session for replay.

Proposal **7** is M5 (memory) territory by definition.

Track open question: **OpenDev experience pipeline** (arXiv 2603.05344)
is the closest published rival to emerge's experience library. If it
ships a leaderboard entry attributing score to that mechanism, revisit
the M5 memory + experience plan.

## ADR slots reserved

When proposals land, write:
- ADR 0034 — pre-dispatch tool-call correction layer
- ADR 0035 — kernel-enforced verification gate (extends ADR 0032)
- ADR 0036 — marker-based early command completion
