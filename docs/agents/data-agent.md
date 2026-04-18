# Data Agent

Transform, aggregate, query, and analyze data. Typical use: ETL pipelines, data cleaning, analytics queries, report generation.

## When to use

- **SQL queries, CSV/JSON processing** — database + file manipulation.
- **No web access** — work with local data, no external APIs.
- **Batch-friendly** — 5–30 minute tasks OK; not latency-critical.
- **Deterministic output** — transform rules are stable; cheap models suffice.
- **Audit trail needed** — track every transformation step.

## Recommended blueprint (emerge-as-host)

```typescript
const dataAgentSpec: AgentSpec = {
  id: "data-1",
  role: "analyst",
  description: "Transforms and analyzes data",

  provider: {
    kind: "router",
    preference: ["anthropic", "openai"],
    criteria: {
      latencyTier: "batch",  // Speed is not critical
      maxUsdPerCall: 0.10,   // Cheaper models OK
    }
  },

  system: {
    kind: "literal",
    text: `You are a data analyst. When processing data:
1. Understand the schema and data quality issues
2. Write SQL queries or data transformations
3. Execute them and inspect results
4. Report findings and transformations applied
5. Ensure no data loss or corruption

Use available tools: query databases, read/write CSVs, transform JSON.`
  },

  toolsAllowed: [
    "fs.read",
    "fs.write",
    "sql.query",        // [planned: M3c2 via tools-mcp]
    "memory.recall",
  ],

  memoryView: {
    inheritFromSupervisor: true,
    writeTags: ["data-transforms", "query-results"],
    readFilter: { domain: "data" },
  },

  budget: {
    tokensIn: 80_000,    // Moderate context for schema + sample data
    tokensOut: 3_000,    // Results are usually short
    usd: 0.5,            // Batch work; cost is secondary to accuracy
  },

  termination: {
    maxIterations: 10,
    maxWallMs: 1_800_000,  // 30 minutes for large ETL
    budget: { tokensIn: 80_000, tokensOut: 3_000 },
    retry: { transient: 2, nonRetryable: 0 },
    cycle: { windowSize: 5, repeatThreshold: 3 },
    done: {
      kind: "predicate",
      description: "All data transformations complete",
    }
  },

  acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
  capabilities: { tools: ["fs.read", "fs.write"], modalities: ["text"], qualityTier: "standard", streaming: true, interrupts: true, maxConcurrency: 1 },
  lineage: { depth: 0 },

  surveillance: "passive",  // Data tasks are predictable; decompose on failure
};
```

## SDK integration (emerge-as-client)

```typescript
async function analyzeDataset(csvPath: string, query: string) {
  const kernel = new Kernel({ mode: "auto", reproducibility: "free" }, {});
  const provider = new AnthropicProvider();
  kernel.mountProvider(provider);

  const sessionId = `analysis-${Date.now()}` as SessionId;
  kernel.setSession(sessionId, "data-analysis-contract");

  const sandbox = new InProcSandbox(permissionPolicyForMode(modeRegistry, "auto"));
  kernel.getToolRegistry().register(makeFsReadTool(sandbox));
  kernel.getToolRegistry().register(makeFsWriteTool(sandbox));

  const handle = await kernel.spawn({
    id: "data-agent" as AgentId,
    role: "analyst",
    provider: { kind: "static", providerId: "anthropic" },
    system: {
      kind: "literal",
      text: `Analyze the data in ${csvPath}.\n\nTask: ${query}`,
    },
    toolsAllowed: ["fs.read", "fs.write"],
    memoryView: { inheritFromSupervisor: false, writeTags: ["analysis"] },
    budget: { tokensIn: 50_000, tokensOut: 2_000, usd: 0.3 },
    termination: {
      maxIterations: 8,
      maxWallMs: 600_000,
      budget: { tokensIn: 50_000, tokensOut: 2_000 },
      retry: { transient: 2, nonRetryable: 0 },
      cycle: { windowSize: 5, repeatThreshold: 2 },
      done: { kind: "predicate", description: "end_turn" },
    },
    acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
    capabilities: { tools: ["fs.read", "fs.write"], modalities: ["text"], qualityTier: "standard", streaming: true, interrupts: true, maxConcurrency: 1 },
    lineage: { depth: 0 },
    surveillance: "passive",
  });

  if (handle.ok) {
    await kernel.runAgent(handle.value);
    return await kernel.endSession();
  }
  return { ok: false, error: "Spawn failed" };
}
```

## Recommended config defaults

| Field | Value | Why |
|---|---|---|
| `provider.tier` | Haiku / GPT-3.5 | Data tasks are structured; cheap models OK |
| `budget.tokensIn` | 50k–80k | Schema + sample rows |
| `budget.tokensOut` | 1k–3k | Results are concise |
| `budget.usd` | $0.2–$0.5 | Cost is secondary; accuracy first |
| `maxIterations` | 5–10 | Linear pipeline; few iterations |
| `maxWallMs` | 600s–1800s | Batch work; speed is not critical |
| `toolsAllowed` | fs.read, fs.write, sql.query, csv.* | Database + file I/O |
| `surveillance` | "passive" | Decompose on error (e.g., SQL syntax) |
| `latencyTier` | "batch" | Optimize for cost, not speed |

## Common pitfalls

1. **No SQL schema context** — Provide the schema in the system prompt or as a tool input. Agent can't query without understanding table structure.

2. **Large datasets cause token overflow** — Use `projections` to truncate results. Or have agent sample first (SELECT * LIMIT 100) before full queries.

3. **Agent drops data without checking** — Add an Adjudicator that validates row counts before/after. Or require the agent to report "X rows in, Y rows out, Z dropped."

4. **CSV read succeeds but agent doesn't parse it** — Provide a CSV-parse tool or MCP server. MockProvider can script test data; real agents need reliable parsing.

5. **Long-running ETL with no progress visibility** — Use `progress` envelopes. Have agent emit "Processing chunk 3 of 10" so the host knows it's alive.

## Minimal invocation

```typescript
const handle = await kernel.spawn({
  id: "data-1",
  role: "analyst",
  provider: { kind: "static", providerId: "anthropic" },
  system: { kind: "literal", text: "Clean and aggregate the sales data in sales.csv" },
  toolsAllowed: ["fs.read", "fs.write"],
  memoryView: { inheritFromSupervisor: false, writeTags: [] },
  budget: { tokensIn: 50_000, tokensOut: 2_000, usd: 0.3 },
  termination: { maxIterations: 8, maxWallMs: 600_000, done: { kind: "predicate", description: "end_turn" } },
  acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
  capabilities: { tools: ["fs.read", "fs.write"], modalities: ["text"], qualityTier: "standard", streaming: true, interrupts: true, maxConcurrency: 1 },
  lineage: { depth: 0 },
  surveillance: "passive",
});
```

## Links

- **Contracts:**
  - Agent spec: `packages/kernel/src/contracts/agent.ts`
  - Tool registry: `packages/kernel/src/contracts/tool.ts`

- **Implementations:**
  - Tools: `packages/tools/src/`
  - MCP bridge: `packages/tools-mcp/src/` ([planned: M3c2 for SQL])

- **ADRs:**
  - ADR 0012: Adjudicator (validate data integrity)
  - ADR 0030: Tool result projections (truncate large query results)

- **Examples:**
  - `examples/hello-agent/src/index.ts` — Basic fs.read + fs.write

- **Roadmap:**
  - [planned: M3c2] SQL query tool via MCP
  - [planned: M3c2] CSV/JSON parsing tools
  - [planned: M5] Data-specific memory (column lineage, data quality metrics)
