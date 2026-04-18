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
  invoke(req: ProviderRequest): AsyncIterable<ProviderEvent>;
  countTokens(messages: readonly ProviderMessage[]): Promise<Result<number>>;
}

interface ProviderCapabilities {
  readonly id: ProviderId;  // "anthropic" | "openai" | "mock" | custom
  readonly claimed: ClaimedCapabilities;
  readonly observed?: ObservedCapabilities;
}

interface ClaimedCapabilities {
  readonly contextWindow: number;  // e.g., 200000
  readonly maxOutputTokens: number;
  readonly nativeToolUse: boolean;
  readonly streamingToolUse: boolean;
  readonly vision: boolean;
  readonly audio: boolean;
  readonly thinking: boolean;
  readonly latencyTier: "interactive" | "batch";
  readonly costPerMtokIn?: number;  // e.g., 3.0
  readonly costPerMtokOut?: number;  // e.g., 15.0
}

interface ProviderRequest {
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly ProviderToolSpec[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  readonly hint?: string;
  readonly signal?: AbortSignal;
}

type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; toolCallId: string; name: string }
  | { type: "tool_call_input_delta"; toolCallId: string; partial: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "stop"; reason: ProviderStopReason; usage: BudgetUsage }
  | { type: "error"; error: ContractError };

type ProviderStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal" | "error";
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

type ToolResult =
  | { kind: "success"; output: unknown; handle?: ToolResultHandle }
  | { kind: "error"; error: string; code?: string; retriable?: boolean }
  | { kind: "truncated"; preview: string; size: number; handle: ToolResultHandle };

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
| `quota.request` | Budget request | `request: QuotaRequest` | agent | custodian (routed) |
| `quota.grant` \| `quota.deny` \| `quota.partial` | Budget decision | `decision: QuotaDecision` | custodian | agent |
| `artifact.put` | Store artifact | `bytesRef: string, mediaType: string, size: number` | agent | artifact store |
| `artifact.get` | Retrieve artifact | `handle: ArtifactHandle` | agent | artifact store |
| `verdict` | Evaluation result | `verdict: Verdict` | adjudicator | broadcast |
| `human.request` | Approval needed | `prompt: string, options?: string[], schema?: unknown` | agent | host |
| `human.reply` | Approval granted | `reply: unknown` | host | agent |
| `human.timeout` | Approval timed out | (no payload) | host | agent |
| `experience.hint` | Learning hint | `hints: ExperienceMatch[]` | surveillance | agent |

**Subscribe to bus:**
```typescript
const sub = bus.subscribe(
  "my-agent" as AgentId,
  { kind: "from", sender: "my-agent" as AgentId }
);

for await (const envelope of sub.events) {
  if (envelope.kind === "result") {
    console.log(envelope.payload);
  }
}
sub.close();
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

**File:** `packages/kernel/src/contracts/cost.ts` (lines 37–48)

Track USD per agent, per task.

```typescript
interface CostMeter {
  record(entry: Omit<CostLedgerEntry, "at"> & { readonly at?: number }): void;
  ledger(): CostLedger;
  forecast(input: CostForecastInput): CostForecast;
}

interface CostLedger {
  readonly entries: readonly CostLedgerEntry[];
  readonly totals: {
    readonly byAgent: Readonly<Record<AgentId, number>>;
    readonly byContract: Readonly<Record<ContractId, number>>;
    readonly grand: number;
  };
}

interface CostForecast {
  readonly p50: number;
  readonly p95: number;
  readonly basis: "experience" | "heuristic" | "provider-quote";
}
```

**Usage:**
```typescript
const meter = kernel.getCostMeter();
const ledger = meter.ledger();
console.log(`Total: $${ledger.totals.grand.toFixed(4)}`);
console.log(`Per agent:`, ledger.totals.byAgent);
```

## Replay / Recorder API

**File:** `packages/kernel/src/contracts/replay.ts` (lines 16–75)

Record and deterministically replay sessions.

```typescript
interface SessionRecord {
  readonly sessionId: SessionId;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly contractRef: ContractId;
  readonly events: readonly RecordedEvent[];
  readonly schemaVersion: string;
}

type RecordedEvent =
  | { readonly kind: "envelope"; readonly at: number; readonly envelope: BusEnvelope }
  | { readonly kind: "provider_call"; readonly at: number; readonly req: ProviderRequest; readonly events: readonly ProviderEvent[] }
  | { readonly kind: "tool_call"; readonly at: number; readonly call: ToolInvocation; readonly result: ToolResult }
  | { readonly kind: "surveillance_recommendation"; readonly at: number; readonly input: AssessmentInput; readonly recommendation: Recommendation }
  | { readonly kind: "decision"; readonly at: number; readonly agent: AgentId; readonly choice: string; readonly rationale: string }
  | { readonly kind: "lifecycle"; readonly at: number; readonly agent: AgentId; readonly transition: AgentState };
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

**File:** `packages/kernel/src/contracts/common.ts` (lines 29–50)

All tool input/output and blueprint slot constraints use **Standard Schema** — vendor-agnostic schema refs compatible with Zod, Valibot, ArkType.

```typescript
interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

type SchemaRef<I = unknown, O = I> = StandardSchemaV1<I, O>;
```

See ADR 0025 for rationale.

## OpenTelemetry + W3C Trace Context

**File:** `packages/kernel/src/contracts/common.ts` (lines 56–59)

Every envelope carries optional `TraceContext` for distributed tracing.

```typescript
interface TraceContext {
  readonly traceparent: string;  // W3C format per https://www.w3.org/TR/trace-context/
  readonly tracestate?: string;
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

import { Kernel } from "@emerge/kernel/runtime";
```

## See also

- [docs/usage.md](./usage.md) — SDK integration guide with examples
- [docs/agents/index.md](./agents/index.md) — Agent type selection
- [ARCHITECTURE.md](../ARCHITECTURE.md) — Why these contracts exist
- [docs/adr/](./adr/) — Design rationale for each contract
