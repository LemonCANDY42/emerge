/**
 * Compile-time smoke test for @lwrf42/emerge-kernel contracts.
 *
 * Constructs a sample value for every public type. If a contract changes in
 * a breaking way, this file fails to typecheck — which fails CI. The values
 * are not run; this file exists for `tsc -b --noEmit` only.
 */

import type {
  AcceptanceCriterion,
  Address,
  AgentAcl,
  AgentCapabilities,
  AgentCard,
  AgentHandle,
  AgentId,
  AgentSnapshot,
  AgentSpec,
  ApprovalQueue,
  Artifact,
  ArtifactHandle,
  ArtifactInput,
  ArtifactStore,
  AssessmentInput,
  Branch,
  BranchId,
  BranchMerger,
  Budget,
  BudgetUsage,
  Bus,
  BusBackpressureConfig,
  BusEnvelope,
  CompressionPolicyInvariants,
  Constraint,
  Contract,
  ContractError,
  ContractId,
  ContractInput,
  CorrelationId,
  CostForecast,
  CostLedger,
  CostMeter,
  Custodian,
  DecisionLesson,
  DeltaEnvelope,
  Divergence,
  EnvelopeBase,
  Experience,
  ExperienceBundle,
  ExperienceId,
  ExperienceLibrary,
  ExperienceMatch,
  HintBudget,
  HintQuery,
  HumanRequest,
  HumanResponse,
  JudgeResult,
  KernelConfig,
  LineageEdge,
  LineageGuard,
  LineageGuardConfig,
  Memory,
  MemoryItem,
  MemoryLink,
  MergeResult,
  Mode,
  ModeName,
  ModeRegistry,
  PermScope,
  PermissionPolicy,
  PinScope,
  Postmortem,
  ProgressEnvelope,
  ProjectionStep,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderId,
  ProviderRequest,
  ProviderRouting,
  QuotaDecision,
  QuotaLedger,
  QuotaRequest,
  RecallBudget,
  RecallQuery,
  RecallResult,
  RecallScope,
  RecallTrace,
  Recommendation,
  RecordedEvent,
  Replayer,
  ReplyEnvelope,
  ReproducibilityTier,
  RequestEnvelope,
  Result,
  ResultEnvelope,
  RetryBudget,
  Sandbox,
  SchemaRef,
  SessionId,
  SessionRecord,
  SessionRecorder,
  SignalEnvelope,
  SlotSpec,
  SpanEnd,
  SpanStart,
  StepObservation,
  StepProfile,
  Subscription,
  SubscriptionTarget,
  Surveillance,
  SystemPrompt,
  Telemetry,
  TerminationPolicy,
  TerminationPredicate,
  TimeWindow,
  Tool,
  ToolEffect,
  ToolInvocation,
  ToolName,
  ToolRegistry,
  ToolResult,
  ToolResultProjection,
  Topology,
  TopologyDelta,
  TopologyEdge,
  TopologyKind,
  TopologySnapshot,
  TopologySpec,
  TraceContext,
  Verdict,
  Workspace,
  WorkspaceManager,
} from "@lwrf42/emerge-kernel/contracts";

// Branded id helpers (cast through unknown to keep callers honest).
const id = <T>(s: string) => s as unknown as T;

const sessionId = id<SessionId>("sess-1");
const agentA = id<AgentId>("agent-a");
const agentB = id<AgentId>("agent-b");
const contractId = id<ContractId>("contract-1");
const correlationId = id<CorrelationId>("corr-1");
const artifactHandle = id<ArtifactHandle>("art-1");
const branchId = id<BranchId>("branch-1");
const experienceId = id<ExperienceId>("exp-1");
const providerId: ProviderId = "anthropic-claude-opus-4-7";

const schema: SchemaRef = {
  "~standard": {
    version: 1,
    vendor: "smoke",
    validate: (v) => ({ value: v }),
  },
};

const traceContext: TraceContext = {
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
};

const budget: Budget = { tokensIn: 100_000, tokensOut: 4096, usd: 1.0 };
const usage: BudgetUsage = { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 };

const retry: RetryBudget = { transient: 3, nonRetryable: 0 };
const termination: TerminationPolicy = {
  maxIterations: 50,
  maxWallMs: 60_000,
  budget,
  retry,
  cycle: { windowSize: 5, repeatThreshold: 3 },
  done: { kind: "tool_emitted", tool: "complete_task" },
};

const acl: AgentAcl = {
  acceptsRequests: "supervisor-only",
  acceptsQueries: "supervisor-only",
  acceptsSignals: "custodian-and-adjudicator-only",
  acceptsNotifications: "any",
};

const capabilities: AgentCapabilities = {
  tools: ["fs.read", "fs.write"],
  modalities: ["text"],
  qualityTier: "standard",
  streaming: true,
  interrupts: true,
  maxConcurrency: 1,
};

const card: AgentCard = {
  id: agentA,
  role: "worker",
  description: "Smoke worker.",
  capabilities,
  io: { accepts: schema, produces: schema },
  budget,
  termination,
  acl,
  lineage: { depth: 0 },
};

const spec: AgentSpec = {
  id: agentA,
  role: "worker",
  provider: { kind: "static", providerId },
  system: { kind: "literal", text: "You are a worker." },
  toolsAllowed: ["fs.read", "fs.write"],
  memoryView: { inheritFromSupervisor: false, writeTags: ["worker"] },
  budget,
  termination,
  acl,
  capabilities,
  lineage: { depth: 0 },
};

const requestEnvelope: RequestEnvelope = {
  kind: "request",
  correlationId,
  sessionId,
  from: agentB,
  to: { kind: "agent", id: agentA },
  timestamp: Date.now(),
  traceContext,
  payload: { hello: "world" },
  card,
};

const deltaEnvelope: DeltaEnvelope = {
  kind: "delta",
  correlationId,
  sessionId,
  from: agentA,
  to: { kind: "agent", id: agentB },
  timestamp: Date.now(),
  chunk: "partial",
  seq: 0,
};

const resultEnvelope: ResultEnvelope = {
  kind: "result",
  correlationId,
  sessionId,
  from: agentA,
  to: { kind: "agent", id: agentB },
  timestamp: Date.now(),
  payload: { ok: true },
};

const signalEnvelope: SignalEnvelope = {
  kind: "signal",
  correlationId,
  sessionId,
  from: agentB,
  to: { kind: "agent", id: agentA },
  timestamp: Date.now(),
  signal: "interrupt",
};

const replyEnvelope: ReplyEnvelope = {
  kind: "reply",
  correlationId,
  sessionId,
  from: agentB,
  to: { kind: "agent", id: agentA },
  timestamp: Date.now(),
  answer: 42,
};

const progressEnvelope: ProgressEnvelope = {
  kind: "progress",
  correlationId,
  sessionId,
  from: agentA,
  to: { kind: "agent", id: agentB },
  timestamp: Date.now(),
  percent: 50,
};

const envelope: BusEnvelope = requestEnvelope;
const subTarget: SubscriptionTarget = { kind: "self" };
const busConfig: BusBackpressureConfig = { bufferSize: 256 };

const acceptanceCriterion: AcceptanceCriterion = {
  kind: "predicate",
  description: "outputs.notes.length > 0",
};
const constraint: Constraint = { kind: "deadline", notAfter: Date.now() + 86_400_000 };
const contractInput: ContractInput = { name: "topic", schema };
const contract: Contract = {
  id: contractId,
  goal: "Summarize the README and write it to NOTES.md.",
  acceptanceCriteria: [acceptanceCriterion],
  inputs: [contractInput],
  outputs: [{ name: "notes", schema }],
  constraints: [constraint, { kind: "budget", budget }],
  hash: "deadbeef",
};

const verdict: Verdict = {
  kind: "aligned",
  rationale: "All acceptance criteria satisfied.",
  evidence: [artifactHandle],
};

const quotaRequest: QuotaRequest = {
  correlationId,
  from: agentA,
  ask: { tokensOut: 2048 },
  rationale: "Output is longer than estimated.",
};
const quotaDecision: QuotaDecision = {
  kind: "partial",
  granted: { tokensOut: 1024 },
  rationale: "Half of the request granted.",
};
const quotaLedger: QuotaLedger = {
  entries: [{ at: Date.now(), request: quotaRequest, decision: quotaDecision }],
};

const artifactInput: ArtifactInput = {
  bytes: new Uint8Array(0),
  meta: { size: 0, mediaType: "text/plain", ownerAgent: agentA, tags: [] },
};

const projectionStep: ProjectionStep = { kind: "cap", maxBytes: 4096 };
const projection: ToolResultProjection = { tool: "*", steps: [projectionStep] };

const topologySpec: TopologySpec = { kind: "supervisor-worker", config: {} };
const topology: Topology = {
  spec: topologySpec,
  members: [
    { agent: agentA, role: "supervisor" },
    { agent: agentB, role: "worker" },
  ],
  edges: [{ from: agentA, to: agentB, kind: "request" }],
};
const topologySnapshot: TopologySnapshot = { at: Date.now(), topology };
const topologyDelta: TopologyDelta = {
  at: Date.now(),
  added: { members: [], edges: [] },
  removed: { members: [], edges: [] },
};

const lineageEdge: LineageEdge = { parent: agentA, child: agentB, at: Date.now() };
const lineageConfig: LineageGuardConfig = { maxDepth: 4 };

const permission: PermissionPolicy = {
  fs: { read: "auto", write: "ask", delete: "deny" },
  net: { read: "auto", write: "ask" },
  process: { spawn: "ask", kill: "deny" },
  agent: { spawn: "ask", message: "auto" },
  tools: { allow: "all" },
  mcp: { servers: "all" },
};

const mode: Mode = {
  name: "auto",
  permissionPolicy: permission,
  toolSurface: { available: ["fs.read", "fs.write"] },
  behavior: {
    confirmBeforeWrites: false,
    confirmBeforeNetwork: false,
    confirmBeforeSpawn: false,
    autoAccept: true,
    planFirst: false,
    readOnly: false,
  },
};

const reproducibility: ReproducibilityTier = "record-replay";
const divergence: Divergence = {
  at: Date.now(),
  providerId,
  tier: "pinned",
  category: "text",
  expectedHash: "h1",
  actualHash: "h2",
};

const cost: CostLedger = {
  entries: [],
  totals: {
    byAgent: {} as Readonly<Record<AgentId, number>>,
    byContract: {} as Readonly<Record<ContractId, number>>,
    grand: 0,
  },
};
const costForecast: CostForecast = { p50: 0.05, p95: 0.15, basis: "heuristic" };

const humanRequest: HumanRequest = { correlationId, prompt: "Approve write?", timeoutMs: 60_000 };
const humanResponse: HumanResponse = { kind: "reply", correlationId, value: "yes" };

const workspace: Workspace = { id: id("ws-1"), root: "/tmp/ws-1", status: "active" };
const mergeResult: MergeResult = { applied: true, conflicts: [] };

const branch: Branch = {
  id: branchId,
  spec: topologySpec,
  workspace: workspace.id,
  hypothesis: "Try a smaller decomposition.",
  status: "running",
};
const judge: JudgeResult = {
  winners: [branchId],
  verdicts: { [branchId]: verdict } as Readonly<Record<BranchId, Verdict>>,
  rationale: "won on quality",
};

const experience: Experience = {
  id: experienceId,
  taskType: "code-refactor",
  approachFingerprint: "abc123",
  description: "Refactor with progressive isolation.",
  optimizedTopology: topologySpec,
  decisionLessons: [{ stepDescription: "split", chosen: "by-module", worked: true }],
  outcomes: { aligned: true, cost: 0.05, wallMs: 12_000, verdict },
  evidence: [artifactHandle],
  provenance: { sourceSessions: [sessionId] },
  schemaVersion: "1",
};
const experienceMatch: ExperienceMatch = {
  experience,
  score: 0.91,
  components: { approach: 0.9, taskType: 0.95 },
  reason: "approach matched",
};
const hintQuery: HintQuery = { taskType: "code-refactor" };
const hintBudget: HintBudget = { maxItems: 3 };

const sessionRecord: SessionRecord = {
  sessionId,
  startedAt: Date.now(),
  contractRef: contractId,
  events: [{ kind: "envelope", at: Date.now(), envelope }],
  schemaVersion: "1",
};

const recordedEvent: RecordedEvent = { kind: "envelope", at: Date.now(), envelope };

const compressionInvariants: CompressionPolicyInvariants = {
  preservesPins: true,
  rendersPinsOnRecall: true,
};
const pinScope: PinScope = "contract";

const slot: SlotSpec = { name: "provider", required: true, accepts: schema };

const memoryItem: MemoryItem = {
  id: "m1",
  createdAt: Date.now(),
  tier: "working",
  content: "hello",
  attributes: {},
  pin: pinScope,
};
const memoryLink: MemoryLink = { to: "m2", kind: "refers" };
const recallQuery: RecallQuery = {};
const recallScope: RecallScope = { session: sessionId };
const recallBudget: RecallBudget = { maxItems: 10 };
const recallTrace: RecallTrace = { items: [], droppedForBudget: 0 };

const stepProfile: StepProfile = {
  stepId: "step-1",
  difficulty: "medium",
  goal: "Summarize README",
  tools: ["fs.read"],
};

const recommendation: Recommendation = { kind: "proceed", confidence: 0.9, rationale: "ok" };
const stepObservation: StepObservation = {
  stepId: "step-1",
  agent: agentA,
  success: true,
  retries: 0,
  toolErrors: 0,
  selfCorrections: 0,
  wallMs: 1000,
};
const assessmentInput: AssessmentInput = {
  agent: agentA,
  providerId,
  capabilities: {
    id: providerId,
    claimed: {
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      nativeToolUse: true,
      streamingToolUse: true,
      vision: true,
      audio: false,
      thinking: true,
      latencyTier: "interactive",
    },
  },
  step: stepProfile,
  decompositionDepth: 0,
};

const kernelConfig: KernelConfig = {
  mode: "auto",
  reproducibility: "free",
  lineage: lineageConfig,
  bus: busConfig,
  roles: { custodian: id<AgentId>("custodian") },
};

const result: Result<number> = { ok: true, value: 1 };
const err: ContractError = { code: "E_TEST", message: "test" };
const address: Address = { kind: "agent", id: agentA };

// Force-use every binding so unused-import lint stays quiet.
export const _smoke = {
  sessionId,
  agentA,
  agentB,
  contractId,
  correlationId,
  artifactHandle,
  branchId,
  experienceId,
  providerId,
  schema,
  traceContext,
  budget,
  usage,
  retry,
  termination,
  acl,
  capabilities,
  card,
  spec,
  requestEnvelope,
  deltaEnvelope,
  resultEnvelope,
  signalEnvelope,
  replyEnvelope,
  progressEnvelope,
  envelope,
  subTarget,
  busConfig,
  acceptanceCriterion,
  constraint,
  contractInput,
  contract,
  verdict,
  quotaRequest,
  quotaDecision,
  quotaLedger,
  artifactInput,
  projectionStep,
  projection,
  topologySpec,
  topology,
  topologySnapshot,
  topologyDelta,
  lineageEdge,
  lineageConfig,
  permission,
  mode,
  reproducibility,
  divergence,
  cost,
  costForecast,
  humanRequest,
  humanResponse,
  workspace,
  mergeResult,
  branch,
  judge,
  experience,
  experienceMatch,
  hintQuery,
  hintBudget,
  sessionRecord,
  recordedEvent,
  compressionInvariants,
  pinScope,
  slot,
  memoryItem,
  memoryLink,
  recallQuery,
  recallScope,
  recallBudget,
  recallTrace,
  stepProfile,
  recommendation,
  stepObservation,
  assessmentInput,
  kernelConfig,
  result,
  err,
  address,
};

// Type-level assertions: verify a few cross-references compile.
export type _AgentSpecHasTermination = AgentSpec["termination"];
export type _AgentCardHasAcl = AgentCard["acl"];
export type _MemoryItemHasPin = MemoryItem["pin"];
export type _BusEnvelopeIsUnion = BusEnvelope["kind"];

// C4: Verify that WorkspaceAllocation.baseRef is typed as string, so a value
// like "--evil" is accepted as a string literal (not parsed as a flag).
// The `--` separator is added by GitWorktreeWorkspaceManager; callers
// never craft the git argv directly.
export type _C4BaseRefIsSafeString = Workspace["baseRef"] extends string | undefined ? true : never;
const _c4EvilRef: NonNullable<Workspace["baseRef"]> = "--evil";
export const _c4Smoke = _c4EvilRef; // type-checks; no git is invoked

// Interfaces that need a value for full instantiation are skipped in the
// runtime sample (they require a real implementation), but we reference
// them as types here to ensure they compile.
export type _CompileChecks = [
  AgentHandle,
  AgentSnapshot,
  ApprovalQueue,
  Artifact,
  ArtifactStore,
  BranchMerger,
  Bus,
  CostMeter,
  Custodian,
  ExperienceLibrary,
  LineageGuard,
  Memory,
  ModeRegistry,
  Postmortem,
  Provider,
  ProviderEvent,
  ProviderRequest,
  ProviderRouting,
  RecallResult,
  Replayer,
  Sandbox,
  SessionRecorder,
  SignalEnvelope,
  SubscriptionTarget,
  Subscription,
  Surveillance,
  SystemPrompt,
  Telemetry,
  TerminationPredicate,
  TimeWindow,
  Tool,
  ToolEffect,
  ToolInvocation,
  ToolName,
  ToolRegistry,
  ToolResult,
  WorkspaceManager,
  ModeName,
  PermScope,
  SpanStart,
  SpanEnd,
  ProviderCapabilities,
];
