# Research Agent

Read-heavy agent for gathering information, fetching documents, summarizing findings. Typical use: literature review, market research, competitive analysis, web scraping.

## When to use

- **Multiple document sources** — PDFs, websites, databases, APIs.
- **No code execution** — analyze, don't implement.
- **Summary as output** — synthesize findings, compare options, detect patterns.
- **Cheap inference OK** — Haiku-class models are sufficient; surveillance handles decomposition.
- **Web + memory as tools** — MCP servers (web search, API clients), filesystem read.

## Recommended blueprint (emerge-as-host)

Core config for a research agent spawned inside emerge:

```typescript
import type { AgentSpec, SurveillanceProfile } from "@emerge/kernel/contracts";
import type { ProviderId } from "@emerge/kernel/contracts";

const researchAgentSpec: AgentSpec = {
  // Identity
  id: "research-1" as const,
  role: "researcher",
  description: "Gathers and summarizes information from multiple sources",

  // Provider routing
  provider: {
    kind: "router",
    preference: ["anthropic", "openai", "mock"],
    criteria: {
      latencyTier: "interactive",
      maxUsdPerCall: 0.10,  // Cheap models are OK
    }
  },

  // System prompt
  system: {
    kind: "literal",
    text: `You are a research assistant. Your task: gather information from provided sources.
Approach:
1. Scan all available sources
2. Extract key facts and quotes
3. Identify patterns and inconsistencies
4. Summarize findings clearly
5. Report sources you consulted

Be thorough. Do not make up data. When uncertain, say so.`
  },

  // Tools
  toolsAllowed: [
    "fs.read",              // Read local documents
    "memory.recall",        // Retrieve previous findings [planned: M5]
    // Add MCP tools for web search, API access
    // "web.search",        // [planned: M3c2 via tools-mcp]
    // "api.call",          // [planned: M3c2 via tools-mcp]
  ],

  // Memory view
  memoryView: {
    inheritFromSupervisor: true,  // See parent's context if spawned by supervisor
    writeTags: ["findings", "sources"],  // Tag outputs so they're findable
    readFilter: { domain: "research" },  // Only read relevant previous findings
  },

  // Budget
  budget: {
    tokensIn: 100_000,   // Large context for document reading
    tokensOut: 5_000,    // Synthesis is cheaper than generation
    usd: 1.0,            // ~$1 per research task
  },

  // Termination
  termination: {
    maxIterations: 15,  // Multiple documents, multi-turn analysis
    maxWallMs: 600_000, // 10 minutes for thorough research
    budget: { tokensIn: 100_000, tokensOut: 5_000 },
    retry: { transient: 3, nonRetryable: 0 },
    cycle: { windowSize: 5, repeatThreshold: 3 },  // Detect if stuck re-reading same doc
    done: {
      kind: "predicate",
      description: "Agent signals research complete with summary and sources cited",
    }
  },

  // Access control
  acl: {
    acceptsRequests: "any",
    acceptsQueries: "any",
    acceptsSignals: "any",
    acceptsNotifications: "any",
  },

  // Advertised capabilities
  capabilities: {
    tools: ["fs.read", "memory.recall"],
    modalities: ["text"],  // Text-only; no vision (yet)
    qualityTier: "standard",
    streaming: true,
    interrupts: true,
    maxConcurrency: 1,
  },

  // Lineage
  lineage: { depth: 0 },  // Or depth 1 if spawned by supervisor

  // Surveillance: passive (let weak models attempt; decompose on failure)
  surveillance: "passive" as SurveillanceProfile,
};
```

## SDK integration (emerge-as-client)

Minimal example: embed a research agent in a TypeScript app.

```typescript
import { Kernel } from "@emerge/kernel/runtime";
import { MockProvider } from "@emerge/provider-mock";
import { makeFsReadTool } from "@emerge/tools";
import { InProcSandbox } from "@emerge/sandbox-inproc";
import { BuiltinModeRegistry, permissionPolicyForMode } from "@emerge/modes";
import type { AgentId, SessionId } from "@emerge/kernel/contracts";

async function runResearchTask(goal: string, documentPath: string) {
  // 1. Set up the kernel
  const kernel = new Kernel(
    {
      mode: "research",  // Read-only mode, network OK
      reproducibility: "free",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 256 },
    },
    {}
  );

  // 2. Mount a provider (MockProvider for demo; swap for AnthropicProvider)
  const provider = new MockProvider([
    {
      events: [
        { type: "text_delta", text: "I'll read the document now. " },
        { type: "tool_call_start", toolCallId: "tc-1", name: "fs.read" },
        { type: "tool_call_input_delta", toolCallId: "tc-1", partial: JSON.stringify({ path: documentPath }) },
        { type: "tool_call_end", toolCallId: "tc-1" },
        { type: "text_delta", text: "The document discusses..." },
        { type: "stop", reason: "end_turn", usage: { tokensIn: 500, tokensOut: 200, wallMs: 1000, toolCalls: 1, usd: 0.005 } },
      ],
    },
  ]);
  kernel.mountProvider(provider);

  // 3. Set session
  const sessionId = `research-${Date.now()}` as SessionId;
  kernel.setSession(sessionId, "research-task-contract");

  // 4. Register tools
  const modeRegistry = new BuiltinModeRegistry();
  const policy = permissionPolicyForMode(modeRegistry, "research");
  const sandbox = new InProcSandbox(policy);
  const toolRegistry = kernel.getToolRegistry();
  toolRegistry.register(makeFsReadTool(sandbox));

  // 5. Spawn the research agent
  const agentId = "research-1" as AgentId;
  const spawnResult = await kernel.spawn({
    id: agentId,
    role: "researcher",
    description: "Research task",
    provider: { kind: "static", providerId: provider.capabilities.id },
    system: {
      kind: "literal",
      text: `You are a research assistant. Goal: ${goal}\n\nAnalyze the provided documents thoroughly.`,
    },
    toolsAllowed: ["fs.read"],
    memoryView: { inheritFromSupervisor: false, writeTags: ["findings"] },
    budget: { tokensIn: 50_000, tokensOut: 5_000, usd: 0.5 },
    termination: {
      maxIterations: 10,
      maxWallMs: 300_000,
      budget: { tokensIn: 50_000, tokensOut: 5_000 },
      retry: { transient: 3, nonRetryable: 0 },
      cycle: { windowSize: 5, repeatThreshold: 3 },
      done: { kind: "predicate", description: "Agent finishes with end_turn" },
    },
    acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
    capabilities: { tools: ["fs.read"], modalities: ["text"], qualityTier: "standard", streaming: true, interrupts: true, maxConcurrency: 1 },
    lineage: { depth: 0 },
    surveillance: "passive",
  });

  if (!spawnResult.ok) {
    console.error("Spawn failed:", spawnResult.error);
    return { ok: false, error: spawnResult.error };
  }

  const handle = spawnResult.value;

  // 6. Listen to results
  const results: string[] = [];
  const bus = kernel.getBus();
  const unsub = bus.subscribe(
    { kind: "agent", id: agentId },
    async (envelope) => {
      if (envelope.kind === "delta") {
        results.push(envelope.chunk as string);
      }
    }
  );

  // 7. Run the agent
  console.log(`Running research task: ${goal}`);
  await kernel.runAgent(handle);

  unsub();

  // 8. End session and collect results
  const endResult = await kernel.endSession();
  if (endResult.ok) {
    const cost = kernel.getCostMeter().ledger();
    return {
      ok: true,
      findings: results.join(""),
      costUsd: cost.totals.grand,
      sessionId,
    };
  } else {
    return { ok: false, error: endResult.error };
  }
}

// Usage
const result = await runResearchTask(
  "Summarize the key findings on renewable energy trends",
  "./documents/renewable-energy.pdf"
);
if (result.ok) {
  console.log("Findings:", result.findings);
  console.log(`Cost: $${result.costUsd.toFixed(4)}`);
} else {
  console.error("Task failed:", result.error);
}
```

## Recommended config defaults

| Field | Value | Why |
|---|---|---|
| `provider.tier` | Haiku / GPT-3.5 | Cheap; surveillance decomposes if needed |
| `budget.tokensIn` | 50k–100k | Large context for documents |
| `budget.tokensOut` | 2k–5k | Synthesis is shorter than generation |
| `budget.usd` | $0.5–$2.0 | Research tasks are inexpensive |
| `maxIterations` | 10–15 | Multiple sources, multi-turn analysis |
| `maxWallMs` | 300s–600s | Thorough reading > speed |
| `toolsAllowed` | fs.read, memory.recall, web.* | Read-only focus |
| `surveillance` | "passive" | Decompose on failure, don't assume strength |
| `memoryView.inheritFromSupervisor` | true | Reuse findings from parent context |
| `acl.acceptsRequests` | "any" (or restricted to supervisor) | If in a topology, restrict to supervisor |

## Common pitfalls

1. **Large documents truncated without warning** — Use `projections` to apply truncation-aware tool results (ADR 0033). Plan for max 8k-token documents per call.

2. **Re-reading the same source multiple times** — Enable cycle guard: set `cycle.windowSize: 5, repeatThreshold: 3`. If agent calls fs.read on the same file 3 times in 5 steps, it halts.

3. **No memory context between runs** — Mount a shared Memory in KernelConfig. Use `memoryView.writeTags: ["findings"]` so later agents can query "what have I learned about X?"

4. **Summarization becomes noise** — Provide a clear summary format in the system prompt: "Use this exact format: FINDING: [claim]. SOURCE: [file/url]. CONFIDENCE: [high/medium/low]."

5. **Web fetching not wired** — Research agents need MCP tools (web search, API calls). Use `@emerge/tools-mcp` to wrap MCP servers; see [planned: M3c2 for bundled web/API tools].

## Minimal invocation

Shortest working snippet (MockProvider, no external APIs):

```typescript
const handle = await kernel.spawn({
  id: "r1",
  role: "researcher",
  provider: { kind: "static", providerId: "mock" },
  system: { kind: "literal", text: "You are a researcher." },
  toolsAllowed: [],
  memoryView: { inheritFromSupervisor: false, writeTags: [] },
  budget: { tokensIn: 10_000, tokensOut: 1_000, usd: 0.1 },
  termination: { maxIterations: 5, maxWallMs: 10_000, done: { kind: "predicate", description: "end_turn" } },
  acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
  capabilities: { tools: [], modalities: ["text"], qualityTier: "standard", streaming: true, interrupts: true, maxConcurrency: 1 },
  lineage: { depth: 0 },
  surveillance: "passive",
});
if (handle.ok) await kernel.runAgent(handle.value);
```

## Links

- **Contracts:**
  - Agent spec: `packages/kernel/src/contracts/agent.ts` (lines 18–35 for core fields)
  - Tool registry: `packages/kernel/src/contracts/tool.ts`
  - Memory view: `packages/kernel/src/contracts/agent.ts` (lines 60–67)
  - Surveillance: `packages/kernel/src/contracts/surveillance.ts`

- **Implementations:**
  - Role helpers: `packages/agents/src/roles/` (postmortem example; research is a simple spec)
  - Topology builders: `packages/agents/src/topologies/supervisor-worker.ts`
  - Tool registry: `packages/tools/src/`
  - MCP bridge: `packages/tools-mcp/src/` ([planned: M3c2 for web/API])

- **ADRs:**
  - ADR 0011: Custodian role (optional for research, but recommended for multi-step tasks)
  - ADR 0012: Adjudicator role (gate output quality)
  - ADR 0030: Tool result projections (truncate large responses)
  - ADR 0033: Truncation-aware tool results

- **Examples:**
  - `examples/hello-agent/src/index.ts` — Basic read + write demo (copy for research)
  - `examples/hello-agent-anthropic/src/index.ts` — Real provider integration
  - `examples/topology-supervisor-worker/src/index.ts` — Multi-agent with roles
  - `examples/eval-probes/src/index.ts` — Surveillance in action (weak vs. strong model)

- **Roadmap:**
  - [planned: M3c2] Web search + API MCP tools
  - [planned: M5] Durable memory (semantic recall of previous findings)
  - [planned: M5] Experience library (learn from past research tasks)
