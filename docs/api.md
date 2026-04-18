# API Reference — Kernel, Provider, Tool, Bus

Concise reference for all public contracts. Links point to source files. For detailed explanation, see [docs/usage.md](./usage.md).

## Kernel facade

**File:** `packages/kernel/src/runtime/kernel.ts`

| Method | Signature | Since | Notes |
|---|---|---|---|
| `constructor(config, modules)` | `new Kernel(KernelConfig, KernelModules)` | M1 | Create kernel instance |
| `mountProvider(provider)` | `mountProvider(p: Provider): void` | M1 | Register a provider for routing |
| `setSession(sessionId, contractId)` | `setSession(id: SessionId, cid: ContractId): void` | M1 | Attach a session; auto-starts recorder |
| `getToolRegistry()` | `getToolRegistry(): ToolRegistry` | M1 | Get tool registry for registration |
| `spawn(spec)` | `spawn(s: AgentSpec): Promise<Result<AgentHandle>>` | M1 | Create and start agent |
| `runAgent(handle)` | `runAgent(h: AgentHandle): Promise<void>` | M1 | Drive the perceive→decide→act→observe loop |
| `endSession()` | `endSession(): Promise<Result<SessionEnd>>` | M1 | Finalize session, invoke Adjudicator |
| `getBus()` | `getBus(): Bus` | M1 | Access the message bus |
| `getMemory()` | `getMemory(): Memory` | M1 | Access working memory |
| `getCostMeter()` | `getCostMeter(): CostMeter` | M3c1 | Query USD ledger per agent/task |
| `mountSchemaAdapter(providerId, adapter)` | `mountSchemaAdapter(pid: ProviderId, sa: SchemaAdapter): void` | M3b | Normalize tool schemas per provider |
| `mountPostmortem(pm)` | `mountPostmortem(p: Postmortem): void` | M3a | Register postmortem analyzer |
| `mountExperienceLibrary(lib)` | `mountExperienceLibrary(l: ExperienceLibrary): void` | M3a | Register experience store |
| `mountSurveillance(surv)` | `mountSurveillance(s: Surveillance): void` | M2 | Override default surveillance |

## Provider contract

**File:** `packages/kernel/src/contracts/provider.ts`

All providers implement this interface. Kernel routes calls per-agent spec.

```typescript
interface Provider {
  readonly capabilities: ProviderCapabilities;
  
  call(input: ProviderInput): Promise<ProviderOutput>;
}

interface ProviderCapabilities {
  readonly id: ProviderId;  // "anthropic" | "openai" | "mock" | custom
  readonly contextWindow: number;  // e.g., 200000
  readonly nativeTools: boolean;  // true if supports tool_use natively
  readonly vision: boolean;
  readonly thinking: boolean;  // supported in M3c2+
  readonly streaming: boolean;
  readonly costPer1MTokensIn?: number;  // e.g., 3.0
  readonly costPer1MTokensOut?: number;  // e.g., 15.0
  readonly latency?: "interactive" | "batch";
  readonly observed?: {
    probeSuccessRate?: number;  // [0, 1] from calibration
    // ... more fields from surveillance.ts
  };
}

interface ProviderInput {
  messages: Message[];
  tools?: Tool[];
  system?: string;
  // ... model-specific config
}

interface ProviderOutput {
  events: ProviderEvent[];  // discriminated union of streaming events
}

type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; toolCallId: string; name: string }
  | { type: "tool_call_input_delta"; toolCallId: string; partial: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "stop"; reason: "end_turn" | "tool_use" | "max_tokens"; usage: Usage }
  | { type: "error"; error: string };

interface Usage {
  tokensIn: number;
  tokensOut: number;
  wallMs: number;
  toolCalls: number;
  usd: number;
}
```

**Implementations:**
- `@emerge/provider-mock`: Scripted responses, testing
- `@emerge/provider-anthropic`: Claude (Sonnet, Opus, Haiku)
- `@emerge/provider-openai`: GPT (Chat Completions + Responses API)
- `@emerge/provider-openai-compat`: Any OpenAI-compatible endpoint (Ollama, vLLM, etc.)

## Tool contract

**File:** `packages/kernel/src/contracts/tool.ts`

```typescript
interface Tool {
  readonly name: ToolName;
  readonly description: string;
  readonly input: SchemaRef;  // Standard Schema (Zod, Valibot, etc.)
  readonly execute: (input: unknown, context: ToolExecutionContext) => Promise<ToolResult>;
}

interface ToolResult {
  | { kind: "success"; output: unknown; handle?: ToolResultHandle }
  | { kind: "error"; error: string; code?: string; retriable?: boolean }
  | { kind: "truncated"; preview: string; size: number; handle: ToolResultHandle }
}

interface ToolResultHandle {
  id: string;  // opaque key for lazy-loading full result
  preview: string;  // summarized or prefix
  size: number;  // bytes
}

interface ToolExecutionContext {
  agentId: AgentId;
  workspace: Workspace;
  sandbox: Sandbox;  // permission-aware execution boundary
}
```

**Bundled tools:**
- `makeFsReadTool(sandbox, options?)`: Read files from workspace
- `makeFsWriteTool(sandbox, options?)`: Write/append files to workspace
- `makeToolRegistry()`: In-process registry

**Tool registration:**
```typescript
const registry = kernel.getToolRegistry();
registry.register(myTool);
```

## Bus envelope kinds (discriminated union)

**File:** `packages/kernel/src/contracts/bus.ts`

18 envelope kinds, all carrying `EnvelopeBase`:

```typescript
interface EnvelopeBase {
  correlationId: CorrelationId;
  sessionId: SessionId;
  from: AgentId;
  to: Address;
  timestamp: number;
  traceContext?: TraceContext;  // W3C trace-context
}

type Address =
  | { kind: "agent"; id: AgentId }
  | { kind: "topic"; topic: TopicId }
  | { kind: "broadcast" };
```

| Envelope | When | Payload | From | To |
|---|---|---|---|---|
| `request` | Agent A sends work | `payload: unknown, card?: AgentCard` | agent | agent/topic |
| `delta` | Streaming output | `chunk: unknown, seq: number` | agent | topic/broadcast |
| `progress` | Status update | `percent?, step?, currentTool?, note?` | agent | broadcast |
| `query` | Ask parent/host | `question: string, schema?: unknown` | agent | agent/host |
| `reply` | Answer a query | `answer: unknown` | agent/host | agent |
| `result` | Work complete | `payload: unknown, artifacts?: ArtifactHandle[]` | agent | agent/broadcast |
| `signal` | Control flow | `signal: "interrupt" \| "pause" \| "resume" \| "terminate", reason?` | host | agent |
| `notification` | Info only | `content: string` | any | any |
| `handshake` | Agent advertisement | `card: AgentCard` | agent | broadcast |
| `quota_request` | Budget request | `request: QuotaRequest` | agent | custodian (routed) |
| `quota_decision` | Budget grant | `decision: QuotaDecision` | custodian | agent |
| `artifact_put` | Store artifact | `artifact: Artifact` | agent | artifact store |
| `artifact_get` | Retrieve artifact | `handle: ArtifactHandle` | agent | artifact store |
| `verdict` | Evaluation result | `verdict: Verdict` | adjudicator | broadcast |
| `human_request` | Approval needed | `request: HumanRequest` | agent | host |
| `human_reply` | Approval granted | `reply: HumanReply` | host | agent |
| `human_timeout` | Approval timed out | `checkpoint: string` | host | agent |
| `experience_hint` | Learning hint | `hints: ExperienceMatch[]` | surveillance | agent |

**Subscribe to bus:**
```typescript
const unsubscribe = bus.subscribe(
  { kind: "agent", id: "my-agent" },
  async (envelope: BusEnvelope) => {
    if (envelope.kind === "result") {
      console.log(envelope.payload);
    }
  }
);
```

## AgentSpec fields

**File:** `packages/kernel/src/contracts/agent.ts`

```typescript
interface AgentSpec {
  readonly id: AgentId;
  readonly role: string;
  readonly description?: string;
  readonly provider: ProviderRouting;
  readonly system: SystemPrompt;
  readonly toolsAllowed: readonly ToolName[];
  readonly memoryView: MemoryViewSpec;
  readonly budget: Budget;
  readonly termination: TerminationPolicy;
  readonly acl: AgentAcl;
  readonly capabilities: AgentCapabilities;
  readonly lineage: { readonly spawnedBy?: AgentId; readonly depth: number };
  readonly projections?: readonly ToolResultProjection[];
  readonly surveillance?: SurveillanceProfile;
}

type ProviderRouting =
  | { kind: "static"; providerId: ProviderId }
  | { kind: "router"; preference: ProviderId[]; criteria?: ProviderCriteria };

interface ProviderCriteria {
  needsVision?: boolean;
  needsThinking?: boolean;
  latencyTier?: "interactive" | "batch";
  maxUsdPerCall?: number;
}

type SystemPrompt =
  | { kind: "literal"; text: string }
  | { kind: "template"; templateId: string; variables: Record<string, string> };

interface MemoryViewSpec {
  inheritFromSupervisor: boolean;
  writeTags: readonly string[];
  readFilter?: Record<string, string | number | boolean>;
}

interface Budget {
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

type SurveillanceProfile = "off" | "passive" | "active" | "strict";
```

## AgentBlueprint (composition)

**File:** `packages/kernel/src/contracts/blueprint.ts`

Typed, plug-and-play assembly. See `packages/agents/src/blueprint-registry.ts` for validation.

```typescript
interface AgentBlueprint {
  readonly id: BlueprintId;
  readonly description: string;
  readonly slots: BlueprintSlots;
  readonly defaults?: Record<string, unknown>;
  readonly domainExtensions?: Record<string, SlotSpec>;
}

interface BlueprintSlots {
  readonly provider: SlotSpec;
  readonly memoryView: SlotSpec;
  readonly tools: SlotSpec;
  readonly surveillance: SlotSpec;
  readonly prompt: SlotSpec;
  readonly behavior?: readonly SlotSpec[];
}

interface SlotSpec {
  readonly name: string;
  readonly required: boolean;
  readonly accepts: SchemaRef;
  readonly description?: string;
}
```

## Surveillance contract

**File:** `packages/kernel/src/contracts/surveillance.ts`

Model capability assessment and adaptive decomposition.

```typescript
interface Surveillance {
  assess(input: AssessmentInput): Promise<Recommendation>;
  observe(obs: StepObservation): Promise<void>;
  envelope(providerId: ProviderId): ProviderCapabilities["observed"];
}

type Recommendation =
  | { kind: "proceed"; confidence: number; rationale: string }
  | { kind: "decompose"; subSteps: StepProfile[]; rationale: string }
  | { kind: "scaffold"; additions: ScaffoldAddition[]; rationale: string }
  | { kind: "escalate"; delegateTo: ProviderId; rationale: string }
  | { kind: "defer"; checkpoint: string; rationale: string };

interface StepProfile {
  stepId: string;
  difficulty: "trivial" | "small" | "medium" | "large" | "research";
  goal: string;
  tools: ToolName[];
  estimatedTokensIn?: number;
  requiresPlanning?: boolean;
}
```

**Implementation:** `CalibratedSurveillance` in `@emerge/surveillance`.

```typescript
const surveillance = new CalibratedSurveillance({ maxDepth: 4 });
const probes = await surveillance.runProbesAsync(provider);
if (probes.ok) {
  console.log(`Ceiling: ${probes.value.ceiling}`);  // "trivial" | "small" | ... | "research"
}
```

## Cost meter API

**File:** `packages/kernel/src/contracts/cost.ts`

Track USD per agent, per task.

```typescript
interface CostMeter {
  recordCall(agentId: AgentId, usd: number): void;
  ledger(): CostLedger;
  forecast(step: StepProfile): number;  // Estimated USD for next step
}

interface CostLedger {
  byAgent: Record<AgentId, AgentCost>;
  byTask: Record<TaskId, TaskCost>;
  totals: { tokensIn: number; tokensOut: number; grand: number };
}
```

**Usage:**
```typescript
const meter = kernel.getCostMeter();
const ledger = meter.ledger();
console.log(`Total: $${ledger.totals.grand.toFixed(4)}`);
console.log(`Agent: $${ledger.byAgent["my-agent"].usd.toFixed(4)}`);
```

## Replay / Recorder API

**File:** `packages/kernel/src/contracts/replay.ts`

Record and deterministically replay sessions.

```typescript
interface Recorder {
  setSession(sessionId: SessionId, contractId: ContractId): void;
  record(envelope: BusEnvelope): void;
  export(): SessionRecord;  // or write to disk
}

interface SessionRecord {
  readonly sessionId: SessionId;
  readonly contractId: ContractId;
  readonly startedAt: number;
  readonly events: BusEnvelope[];
}
```

**Usage:**
```typescript
import { makeRecorder, makeReplayer } from "@emerge/replay";

const recorder = makeRecorder();
kernel = new Kernel({...}, { recorder });

// Record a session
kernel.setSession(sessionId, contractId);
// ... run agents ...
const record = await kernel.endSession();

// Replay it deterministically
const replayer = makeReplayer(record.value.record.events);
kernel = new Kernel({ reproducibility: "record-replay" }, { replayer });
// ... run again ... all outputs are identical
```

## Standard Schema

**File:** `packages/kernel/src/contracts/common.ts` (imports)

All tool input/output and blueprint slot constraints use **Standard Schema** — vendor-agnostic schema refs compatible with Zod, Valibot, ArkType.

```typescript
type SchemaRef =
  | { kind: "zod"; schema: any }
  | { kind: "valibot"; schema: any }
  | { kind: "arktype"; schema: any }
  | { kind: "json-schema"; schema: unknown };
```

See ADR 0025 for rationale.

## OpenTelemetry + W3C Trace Context

**File:** `packages/kernel/src/contracts/telemetry.ts`

Every envelope carries optional `TraceContext` for distributed tracing.

```typescript
interface TraceContext {
  traceId: string;  // W3C format
  spanId: string;
  parent?: string;
}
```

Planned: `@emerge/telemetry-otel` (M3c2) will emit spans to Phoenix, Langfuse, or any OTel sink.

## Key type imports

```typescript
import type {
  // Core
  AgentId, AgentSpec, AgentHandle, AgentBlueprint,
  SessionId, ContractId, CorrelationId,
  
  // Bus
  BusEnvelope, Address, Verdict, QuotaRequest, QuotaDecision,
  
  // Budget
  Budget, BudgetUsage,
  
  // Tools
  Tool, ToolName, ToolResult, ToolResultHandle,
  
  // Memory
  MemoryItem, MemoryViewSpec, RecallQuery, RecallTrace,
  
  // Surveillance
  Surveillance, Recommendation, StepProfile,
  
  // Termination
  TerminationPolicy,
  
  // Roles
  Custodian, Adjudicator, Postmortem,
  
  // Others
  Provider, ProviderId, ProviderRouting,
  Workspace, ArtifactHandle, Artifact,
  Mode, PermissionPolicy,
  Experience, ExperienceLibrary,
  SessionRecord,
} from "@emerge/kernel/contracts";

import { Kernel, anthropicAdapter } from "@emerge/kernel/runtime";
```

## See also

- [docs/usage.md](./usage.md) — SDK integration guide with examples
- [docs/agents/index.md](./agents/index.md) — Agent type selection
- [ARCHITECTURE.md](../ARCHITECTURE.md) — Why these contracts exist
- [docs/adr/](./adr/) — Design rationale for each contract
