# Code Agent

Implement, refactor, fix bugs, run tests. Typical use: feature development, bug fixes, code review, test-driven debugging.

## When to use

- **Read + write filesystem** — edit source files, create new ones.
- **Execute commands** — run tests, linters, compilers, git operations.
- **Multi-file dependencies** — understand call graphs, refactor across modules.
- **Iterative refinement** — write → test → fix → test again.
- **Strong model needed** — Sonnet/GPT-4 class; cheap models struggle.

## Recommended blueprint (emerge-as-host)

```typescript
const codeAgentSpec: AgentSpec = {
  id: "code-1",
  role: "developer",
  description: "Implements features and fixes bugs in code",

  provider: {
    kind: "router",
    preference: ["anthropic", "openai"],  // Omit mock; need real reasoning
    criteria: {
      latencyTier: "interactive",
      maxUsdPerCall: 0.30,  // Stronger models cost more
    }
  },

  system: {
    kind: "literal",
    text: `You are an expert software engineer. When fixing code:
1. Understand the bug/requirement fully
2. Find the root cause (read related files)
3. Implement the minimal fix
4. Run tests to verify
5. Report the change and test results

Use available tools: read files, write changes, run tests. Be thorough.`
  },

  toolsAllowed: [
    "fs.read",
    "fs.write",
    "shell.exec",      // Run tests, compilers, git
    "memory.recall",   // Context from previous attempts
  ],

  memoryView: {
    inheritFromSupervisor: true,
    writeTags: ["code-changes", "test-results"],
    readFilter: { domain: "code" },
  },

  budget: {
    tokensIn: 200_000,   // Large context for reading code
    tokensOut: 20_000,   // Generated code + explanation
    usd: 5.0,            // Stronger models + longer context
  },

  termination: {
    maxIterations: 25,
    maxWallMs: 1_200_000,  // 20 minutes for complex bugs
    budget: { tokensIn: 200_000, tokensOut: 20_000 },
    retry: { transient: 3, nonRetryable: 0 },
    cycle: { windowSize: 5, repeatThreshold: 3 },
    done: {
      kind: "predicate",
      description: "All tests pass and agent confirms completion",
    }
  },

  acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
  capabilities: { tools: ["fs.read", "fs.write", "shell.exec"], modalities: ["text"], qualityTier: "strong", streaming: true, interrupts: true, maxConcurrency: 1 },
  lineage: { depth: 0 },

  surveillance: "active",  // Decompose on test failure; escalate if stuck
};
```

## SDK integration (emerge-as-client)

```typescript
async function fixBug(bugDescription: string, testCommand: string) {
  const kernel = new Kernel({ mode: "auto", reproducibility: "free" }, {});
  const provider = new AnthropicProvider();  // Real provider
  kernel.mountProvider(provider);

  const sessionId = `bug-fix-${Date.now()}` as SessionId;
  kernel.setSession(sessionId, "bug-fix-contract");

  const sandbox = new InProcSandbox(permissionPolicyForMode(modeRegistry, "auto"));
  kernel.getToolRegistry().register(makeFsReadTool(sandbox));
  kernel.getToolRegistry().register(makeFsWriteTool(sandbox));

  const handle = await kernel.spawn({
    id: "code-agent" as AgentId,
    role: "developer",
    provider: { kind: "static", providerId: "anthropic" },
    system: {
      kind: "literal",
      text: `Fix this bug: ${bugDescription}\n\nVerify with: ${testCommand}`,
    },
    toolsAllowed: ["fs.read", "fs.write"],
    memoryView: { inheritFromSupervisor: false, writeTags: ["fixes"] },
    budget: { tokensIn: 100_000, tokensOut: 10_000, usd: 3.0 },
    termination: {
      maxIterations: 15,
      maxWallMs: 600_000,
      budget: { tokensIn: 100_000, tokensOut: 10_000 },
      retry: { transient: 2, nonRetryable: 0 },
      cycle: { windowSize: 5, repeatThreshold: 2 },
      done: { kind: "predicate", description: "end_turn" },
    },
    acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
    capabilities: { tools: ["fs.read", "fs.write"], modalities: ["text"], qualityTier: "strong", streaming: true, interrupts: true, maxConcurrency: 1 },
    lineage: { depth: 0 },
    surveillance: "active",
  });

  if (handle.ok) {
    await kernel.runAgent(handle.value);
    const endResult = await kernel.endSession();
    return endResult;
  }
  return { ok: false, error: "Spawn failed" };
}
```

## Recommended config defaults

| Field | Value | Why |
|---|---|---|
| `provider.tier` | Sonnet / GPT-4 | Code tasks need strong reasoning |
| `budget.tokensIn` | 100k–200k | Large codebase context |
| `budget.tokensOut` | 5k–20k | Generated code can be large |
| `budget.usd` | $1.0–$5.0 | Stronger models + more tokens = cost |
| `maxIterations` | 15–25 | Test → fix → retest cycles |
| `maxWallMs` | 600s–1200s | Careful implementation > speed |
| `toolsAllowed` | fs.read, fs.write, shell.exec, memory.recall | Full dev environment |
| `surveillance` | "active" | Escalate stuck attempts; decompose |
| `cycle.repeatThreshold` | 2–3 | Detect infinite test-fix loops |

## Common pitfalls

1. **Agent changes files, never verifies with tests** — Mandate test run in termination: done.kind="predicate" checking test pass. Or use Adjudicator to gate completion on test results.

2. **Context window runs out mid-large-refactor** — Use code agent in supervisor + worker topology. Supervisor decomposes into module-sized chunks; each worker refactors one module.

3. **Agent overwrites important code** — Restrict fs.write to a subdirectory. Use workspace isolation (`@lwrf42/emerge-workspaces-git-worktree`) so changes are in a separate git worktree.

4. **Shell execution spawns infinite loops** — Set termination.done to timeout or max iterations. Add shell.exec timeout (e.g., 30 seconds per command).

5. **Agent forgets tests are failing** — Use `surveillance: "active"` and register probes that run tests. Surveillance will trigger decomposition on repeated test failures.

## Minimal invocation

```typescript
const handle = await kernel.spawn({
  id: "code-1",
  role: "developer",
  provider: { kind: "static", providerId: "anthropic" },
  system: { kind: "literal", text: "Fix the failing test in test_suite.py" },
  toolsAllowed: ["fs.read", "fs.write"],
  memoryView: { inheritFromSupervisor: false, writeTags: [] },
  budget: { tokensIn: 100_000, tokensOut: 10_000, usd: 2.0 },
  termination: { maxIterations: 20, maxWallMs: 600_000, done: { kind: "predicate", description: "end_turn" } },
  acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
  capabilities: { tools: ["fs.read", "fs.write"], modalities: ["text"], qualityTier: "strong", streaming: true, interrupts: true, maxConcurrency: 1 },
  lineage: { depth: 0 },
  surveillance: "active",
});
```

## Links

- **Contracts:**
  - Agent spec: `packages/kernel/src/contracts/agent.ts`
  - Tool registry: `packages/kernel/src/contracts/tool.ts`
  - Termination guards: `packages/kernel/src/contracts/termination.ts`

- **Implementations:**
  - Workspace: `packages/workspaces-git-worktree/src/` (isolate changes)
  - Tool registry: `packages/tools/src/`

- **ADRs:**
  - ADR 0005: Tools as checkpoint boundary (understand shell.exec recovery)
  - ADR 0009: Loop and recursion safeguards (cycle guards)
  - ADR 0012: Adjudicator (gate completion on test pass)

- **Examples:**
  - `examples/hello-agent/src/index.ts` — Basic fs.read + fs.write
  - `examples/topology-supervisor-worker/src/index.ts` — Multi-agent code tasks

- **Roadmap:**
  - [planned: M4] Durable persistence (resume after crash without re-running tests)
  - [planned: M5] Experience library (learn best approaches for common bug patterns)
