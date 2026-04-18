# SDK Usage Guide — emerge-as-client

How to embed emerge in your TypeScript app and run agents. This is the **emerge-as-client** perspective: an external system using the emerge SDK.

(For **emerge-as-host** — configuring agents that run *inside* emerge — see [docs/agents/](./agents/index.md).)

## 30-second example

The shortest working snippet:

```typescript
import { Kernel } from "@emerge/kernel/runtime";
import { MockProvider } from "@emerge/provider-mock";

const kernel = new Kernel({ mode: "auto", reproducibility: "free" }, {});
const provider = new MockProvider([
  {
    events: [
      { type: "text_delta", text: "Hello!" },
      { type: "stop", reason: "end_turn", usage: { tokensIn: 10, tokensOut: 5, wallMs: 1, toolCalls: 0, usd: 0 } },
    ],
  },
]);
kernel.mountProvider(provider);

const result = await kernel.spawn({
  id: "simple",
  role: "chat",
  provider: { kind: "static", providerId: provider.capabilities.id },
  system: { kind: "literal", text: "You are helpful." },
  toolsAllowed: [],
  memoryView: { inheritFromSupervisor: false, writeTags: [] },
  budget: { tokensIn: 1000, tokensOut: 100, usd: 0.1 },
  termination: { maxIterations: 5, maxWallMs: 10000, done: { kind: "predicate", description: "any stop" } },
  acl: { acceptsRequests: "any", acceptsQueries: "any", acceptsSignals: "any", acceptsNotifications: "any" },
  capabilities: { tools: [], modalities: ["text"], qualityTier: "standard", streaming: true, interrupts: true, maxConcurrency: 1 },
  lineage: { depth: 0 },
});

if (result.ok) {
  await kernel.runAgent(result.value);
}
```

That's it. The agent runs, the kernel drives the loop, and the provider supplies the model.

## Mount the kernel

Standard 5-line setup:

```typescript
import { Kernel } from "@emerge/kernel/runtime";
import type { SessionId } from "@emerge/kernel/contracts";

// 1. Create the kernel with config
const kernel = new Kernel(
  {
    mode: "auto",                    // permissionPolicy; see docs/api.md
    reproducibility: "free",          // "record-replay" | "pinned" | "free"
    lineage: { maxDepth: 4 },        // recursion guard
    bus: { bufferSize: 256 },        // message queue size
    roles: {},                        // custodian/adjudicator/postmortem/etc (optional)
  },
  {
    // Optional modules (recorder, telemetry, memory, surveillance, etc.)
    // See docs/api.md for the full config shape
  }
);

// 2. Mount a provider
import { MockProvider } from "@emerge/provider-mock";
const provider = new MockProvider([...]);
kernel.mountProvider(provider);

// 3. Set session context (required for recording)
const sessionId = `my-task-${Date.now()}` as SessionId;
kernel.setSession(sessionId, "my-contract-id");

// 4. Register tools (if any)
import { makeFsReadTool } from "@emerge/tools";
import { InProcSandbox } from "@emerge/sandbox-inproc";
const sandbox = new InProcSandbox(...);
kernel.getToolRegistry().register(makeFsReadTool(sandbox));

// 5. Spawn and run agents
const result = await kernel.spawn({ ...agentSpec });
if (result.ok) {
  await kernel.runAgent(result.value);
}
```

## Pick a provider

| Provider | When to use | Config |
|---|---|---|
| **MockProvider** | Testing, demos, CI (no API key) | Deterministic scripted responses. See `examples/hello-agent/`. |
| **AnthropicProvider** | Claude models | Env: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`. See `examples/hello-agent-anthropic/`. |
| **OpenAIProvider** | GPT models (Chat or Responses API) | Env: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_PROTOCOL`. See `examples/hello-agent-openai/`. |
| **OpenAICompatProvider** | Ollama, vLLM, llama.cpp, local models | Env: `EMERGE_LLM_BASE_URL`, `EMERGE_LLM_MODEL`, `EMERGE_LLM_API_KEY`. See `examples/hello-agent-custom-url/`. |

**Provider routing** is per-agent, not per-kernel:

```typescript
// Static: always use this provider
provider: { kind: "static", providerId: "mock-1" }

// Router: try these in order, apply criteria
provider: {
  kind: "router",
  preference: ["anthropic", "openai", "mock"],
  criteria: {
    needsVision: false,
    needsThinking: true,
    latencyTier: "interactive",  // or "batch"
    maxUsdPerCall: 0.10,
  }
}
```

## Spawn an agent

The most important interface. **AgentSpec** defines:

```typescript
const agentSpec: AgentSpec = {
  // Identity
  id: "my-agent" as AgentId,
  role: "researcher",  // string tag; e.g., "supervisor", "worker", "critic"
  description?: "Reads documents and summarizes",

  // Model routing
  provider: { kind: "static", providerId: "anthropic" },

  // Instructions
  system: {
    kind: "literal",
    text: "You are a research assistant. Read carefully. Summarize main points."
  },
  // OR
  system: {
    kind: "template",
    templateId: "research-prompt-v1",
    variables: { domain: "biology", maxLength: "500" }
  },

  // Capabilities
  toolsAllowed: ["fs.read", "web.fetch", "memory.recall"],  // subset of registry
  memoryView: {
    inheritFromSupervisor: true,  // see parent's memory on spawn
    writeTags: ["my-findings"],   // tag this agent's outputs
    readFilter: { domain: "biology" }  // only read memory tagged with domain=biology
  },

  // Budgets
  budget: {
    tokensIn: 50_000,
    tokensOut: 10_000,
    usd: 5.0,
  },

  // Stopping conditions
  termination: {
    maxIterations: 20,
    maxWallMs: 300_000,  // 5 minutes
    budget: { tokensIn: 50_000, tokensOut: 10_000 },  // copied from .budget; triggers early stop
    retry: { transient: 3, nonRetryable: 0 },  // transient errors retried up to 3x
    cycle: { windowSize: 5, repeatThreshold: 3 },  // if same tool 3x in 5 steps → stop
    done: {
      kind: "predicate",
      description: "Agent signals completion with end_turn"
    }
  },

  // Access control
  acl: {
    acceptsRequests: "any",       // "any" | { allow: AgentId[] }
    acceptsQueries: "any",
    acceptsSignals: "any",
    acceptsNotifications: "any",
  },

  // Advertised capabilities
  capabilities: {
    tools: ["fs.read", "web.fetch"],
    modalities: ["text"],  // or ["text", "image"]
    qualityTier: "standard",  // for routing decisions
    streaming: true,
    interrupts: true,
    maxConcurrency: 1,
  },

  // Lineage
  lineage: { depth: 0 },  // spawned by kernel; depth 0 = root agent

  // Optional: apply transformations to tool results before they hit working memory
  projections: [
    {
      toolName: "web.fetch",
      kind: "truncate",
      maxTokens: 500,
    }
  ],

  // Optional: probe model capability before each step
  surveillance: "off" | "passive" | "active" | "strict",
};

// Spawn it
const result = await kernel.spawn(agentSpec);
if (!result.ok) {
  console.error("Spawn failed:", result.error);
  process.exit(1);
}
const handle = result.value;  // AgentHandle
await kernel.runAgent(handle);
```

**Key takeaway:** AgentSpec is *declarative* — you describe what the agent is and what it's allowed to do. The kernel enforces all of it.

## Listen to the bus

The agent produces events on a **Bus**. Subscribe to them:

```typescript
import type { AgentId, BusEnvelope, TopicId } from "@emerge/kernel/contracts";

const bus = kernel.getBus();
const sessionId = "my-session-id" as SessionId;

// Subscribe to all messages from one agent
const sub = bus.subscribe(
  "my-agent" as AgentId,
  { kind: "from", sender: "my-agent" as AgentId }
);

for await (const envelope of sub.events) {
  console.log(`Message kind: ${envelope.kind}`);
  if (envelope.kind === "delta") {
    console.log("Output chunk:", envelope.chunk);
  } else if (envelope.kind === "progress") {
    console.log(`Progress: ${envelope.step} (${envelope.percent}%)`);
  } else if (envelope.kind === "result") {
    console.log("Final result:", envelope.payload);
  } else if (envelope.kind === "verdict") {
    console.log("Verdict:", envelope.verdict.kind);  // "aligned" | "partial" | "off-track" | "failed"
  }
}
sub.close();

// Subscribe to a topic (broadcast by multiple agents)
const topicSub = bus.subscribe(
  "my-agent" as AgentId,
  { kind: "topic", topic: "quota-requests" as TopicId }
);

for await (const envelope of topicSub.events) {
  if (envelope.kind === "quota.request") {
    console.log("Agent requesting quota:", envelope.request);
  }
}
topicSub.close();
```

**Envelope kinds** (the discriminated union):

| Kind | When | Payload |
|---|---|---|
| `request` | Agent A sends work to Agent B | `payload: unknown` |
| `delta` | Streaming output chunk | `chunk: string` (text), `seq: number` |
| `progress` | Agent reports progress | `percent?: number, step?: string, currentTool?: string` |
| `query` | Agent asks the host a question | `question: string, schema?: unknown` |
| `reply` | Host answers a query | `answer: unknown` |
| `result` | Agent finishes | `payload: unknown, artifacts?: ArtifactHandle[]` |
| `signal` | Host interrupts/pauses/resumes agent | `signal: "interrupt" \| "pause" \| "resume" \| "terminate"` |
| `notification` | Informational message | `content: string` |
| `handshake` | Agent advertises itself | `card: AgentCard` |
| `quota.request` | Agent asks Custodian for budget | `request: QuotaRequest` |
| `quota.grant` \| `quota.deny` \| `quota.partial` | Custodian grants/denies/partially grants quota | `decision: QuotaDecision` |
| `artifact.put` | Agent stores an artifact | `bytesRef: string, mediaType: string, size: number` |
| `artifact.get` | Agent retrieves an artifact | `handle: ArtifactHandle` |
| `verdict` | Adjudicator evaluates output | `verdict: Verdict` |
| `human.request` | Agent requests human approval | `prompt: string, options?: string[], schema?: unknown` |
| `human.reply` | Human grants/denies approval | `reply: unknown` |
| `human.timeout` | Human approval timed out | (no payload) |
| `experience.hint` | Surveillance suggests prior experiences | `hints: ExperienceMatch[]` |

## Record and replay

Sessions are recorded by default (when a **Recorder** is mounted). Replay them deterministically:

```typescript
import { makeRecorder } from "@emerge/replay";
import type { SessionRecord } from "@emerge/kernel/contracts";

// Mount the recorder when creating the kernel
const recorder = makeRecorder();
const kernel = new Kernel({ ... }, { recorder });

// Run a session
kernel.setSession(sessionId, contractId);
// ... spawn and run agents ...

// Get the record on exit
const recordResult = await kernel.endSession();
if (recordResult.ok && recordResult.value.record) {
  const record: SessionRecord = recordResult.value.record;
  console.log(`Session recorded: ${record.events.length} events`);

  // Save to disk
  import fs from "node:fs/promises";
  await fs.writeFile(
    `./session-${record.sessionId}.jsonl`,
    record.events.map(e => JSON.stringify(e)).join("\n")
  );
}
```

**Replay a recorded session** (deterministically reproduces everything):

```typescript
import { makeReplayer } from "@emerge/replay";
const recordedEvents = JSON.parse(fs.readFileSync("./session-abc.jsonl", "utf-8").split("\n").filter(Boolean));

const replayer = makeReplayer(recordedEvents);
const kernel = new Kernel({ reproducibility: "record-replay" }, { replayer });

// Run it again — outputs are deterministic
kernel.setSession(sessionId, contractId);
// ... spawn and run ... all model calls are replayed from the log
```

## Terminate and handle results

When an agent finishes:

```typescript
// End the session (triggers Adjudicator verdict if mounted)
const endResult = await kernel.endSession();

if (endResult.ok) {
  const { record, postmortemErrors } = endResult.value;

  // Check the record
  if (record) {
    console.log(`Session recorded: ${record.events.length} events`);

    // Query cost totals
    const cost = kernel.getCostMeter().ledger();
    console.log(`Total USD: $${cost.totals.grand.toFixed(4)}`);
    console.log(`Per agent:`, cost.totals.byAgent);

    // Check for postmortem errors
    if (postmortemErrors) {
      console.log("Postmortem analysis errors:", postmortemErrors);
    }
  }

  // Emit telemetry
  if (record) {
    telemetry.emit({
      sessionId: record.sessionId,
      status: verdict?.kind || "completed",
      tokensIn: cost.totals.tokensIn,
      tokensOut: cost.totals.tokensOut,
      usd: cost.totals.grand,
      duration: Date.now() - record.startedAt,
    });
  }
} else {
  console.error("Session end failed:", endResult.error);
}
```

## Common patterns

### Pattern 1: Tool registration + tool sandbox

```typescript
import { InProcSandbox } from "@emerge/sandbox-inproc";
import { makeFsReadTool, makeFsWriteTool } from "@emerge/tools";
import { BuiltinModeRegistry, permissionPolicyForMode } from "@emerge/modes";

const modeRegistry = new BuiltinModeRegistry();
const policy = permissionPolicyForMode(modeRegistry, "auto");
const sandbox = new InProcSandbox(policy);

const registry = kernel.getToolRegistry();
registry.register(makeFsReadTool(sandbox, { rootPath: "/safe/dir" }));
registry.register(makeFsWriteTool(sandbox, { rootPath: "/safe/dir" }));
```

### Pattern 2: Custom mode with restricted tools

```typescript
import { BuiltinModeRegistry, permissionPolicyForMode } from "@emerge/modes";

const modeRegistry = new BuiltinModeRegistry();
// Pre-defined modes: "auto" (default), "plan", "bypass", "accept-edit", "research", "read"
const policy = permissionPolicyForMode(modeRegistry, "research");

const kernel = new Kernel({ mode: "research", ... }, {});
// "research" mode: read-only, no writes, network allowed, human-in-loop on big decisions
```

### Pattern 3: Supervisor + workers topology

```typescript
import { supervisorWorker } from "@emerge/agents";

const topology = supervisorWorker({
  supervisor: supervisorSpec,
  workers: [workerASpec, workerBSpec, workerCSpec],
  dispatch: "parallel",
  aggregator: (results) => results.join("\n---\n"),  // JS reducer, or undefined for LLM aggregation
});

// Then wire it to the kernel
const result = await topology.run(input, kernel, sessionId);
if (result.ok) {
  console.log("Topology output:", result.value);
}
```

### Pattern 4: Custodian + Adjudicator (contract enforcement)

```typescript
import { buildCustodian, buildAdjudicator } from "@emerge/agents";
import type { Contract } from "@emerge/kernel/contracts";

const contract: Contract = {
  id: "essay-contract" as ContractId,
  goal: "Write a 5-paragraph essay on climate change",
  acceptanceCriteria: [
    { kind: "predicate", description: "≥1500 words" },
    { kind: "predicate", description: "Cited sources" },
    { kind: "predicate", description: "Balanced tone" },
  ],
  inputs: [],
  outputs: [{ name: "essay", schema: { "~standard": { version: 1, vendor: "mock", validate: (v) => ({ value: v }) } } }],
  constraints: [],
  hash: "abc123",
};

const custodian = buildCustodian({
  id: "custodian" as AgentId,
  contract,
  quotaPolicy: (req) => ({
    kind: "grant",
    granted: req.ask,
    rationale: "Grant all requests (demo only)",
  }),
});

const adjudicator = buildAdjudicator({
  id: "adjudicator" as AgentId,
  contract,
  evaluate: (input: EvaluationInput) => {
    // Check: is the output ≥1500 words?
    const text = typeof input.outputs.essay === "string" ? input.outputs.essay : JSON.stringify(input.outputs.essay);
    const wordCount = text.split(/\s+/).length;
    if (wordCount < 1500) {
      return { kind: "off-track", reason: `Only ${wordCount} words; need 1500+`, suggestion: "Expand the essay" };
    }
    return { kind: "aligned", rationale: "Meets acceptance criteria", evidence: input.artifacts };
  },
});

kernel.spawn(custodian.spec);
kernel.spawn(adjudicator.spec);
```

### Pattern 5: Postmortem analysis (session-over-session learning)

```typescript
import type { Postmortem, SessionRecord, Experience, ExperienceId } from "@emerge/kernel/contracts";

class MyPostmortem implements Postmortem {
  async analyze(record: SessionRecord): Promise<Result<readonly Experience[]>> {
    const experiences: Experience[] = [];
    
    // Analyze the session record to extract lessons
    const successfulEnvelopes = record.events.filter(
      e => e.kind === "envelope" && (e as any).envelope.kind === "result"
    );

    if (successfulEnvelopes.length > 0) {
      experiences.push({
        id: `exp-${record.sessionId}` as ExperienceId,
        taskType: "multi-step-research",
        approachFingerprint: "supervisor-decomposition",
        description: "Multi-agent decomposition with parallel workers",
        optimizedTopology: {
          kind: "supervisor-worker",
          config: { dispatch: "parallel" },
        },
        decisionLessons: [
          {
            stepDescription: "Spawn worker pool",
            chosen: "Parallel execution",
            worked: true,
          }
        ],
        outcomes: {
          aligned: true,
          cost: 0.15,
          wallMs: 120000,
        },
        evidence: [],
        provenance: { sourceSessions: [record.sessionId] },
        schemaVersion: "1.0",
      });
    }

    return { ok: true, value: experiences };
  }
}

const postmortem = new MyPostmortem();
kernel.mountPostmortem(postmortem);

// On endSession(), postmortem is auto-invoked if mounted
```

## API reference

For full contract details: see [docs/api.md](./api.md).

Key types to import:
```typescript
import type {
  AgentId, AgentSpec, AgentHandle,
  SessionId, ContractId, BusEnvelope,
  Budget, TerminationPolicy,
  ProviderRouting, Result,
  SurveillanceProfile,
  Verdict, EvaluationInput,
  QuotaRequest, QuotaDecision,
  Contract, Experience, ExperienceId,
  Postmortem,
} from "@emerge/kernel/contracts";

import { Kernel } from "@emerge/kernel/runtime";
import { MockProvider } from "@emerge/provider-mock";
import { CalibratedSurveillance } from "@emerge/surveillance";
import { buildCustodian, buildAdjudicator } from "@emerge/agents";
```

## What's next?

- See [docs/agents/index.md](./agents/index.md) to pick an agent type for your task.
- See [examples/](../examples/) for 10 working demos.
- See [docs/design/roadmap.md](./design/roadmap.md) for planned features ([planned: M4], [planned: M5]).
