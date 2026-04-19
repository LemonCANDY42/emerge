/**
 * Kernel — the top-level facade. Constructor takes KernelConfig + optional modules.
 */

import type { Verdict } from "../contracts/adjudicator.js";
import type { CostMeter } from "../contracts/cost.js";
import type { Custodian } from "../contracts/custodian.js";
import type { ExperienceLibrary, Postmortem } from "../contracts/experience.js";
import type {
  AgentHandle,
  AgentId,
  AgentSpec,
  Bus,
  BusEnvelope,
  ContractError,
  ContractId,
  CorrelationId,
  KernelConfig,
  LineageEdge,
  LineageGuard,
  Memory,
  MemoryItem,
  MemoryTier,
  ModeRegistry,
  Provider,
  RecallBudget,
  RecallQuery,
  RecallResult,
  RecallScope,
  Result,
  Sandbox,
  SandboxDecision,
  SandboxRequest,
  SessionId,
  SessionRecord,
  SessionRecorder,
  SpanId,
  Telemetry,
  Tool,
  ToolRegistry,
  ToolSpec,
  WorkspaceManager,
} from "../contracts/index.js";
import type { Surveillance } from "../contracts/surveillance.js";
import type { TerminationPolicy } from "../contracts/termination.js";
import { AgentRunner } from "./agent-runner.js";
import { InMemoryBus } from "./bus.js";
import { InMemoryCostMeter } from "./cost-meter.js";
import { InMemoryLineageGuard } from "./lineage-guard.js";
import { QuotaRouter } from "./quota-router.js";
import { Scheduler } from "./scheduler.js";
import { SchemaAdapterRegistry } from "./schema-adapter.js";

/**
 * Post-step verification config. Opt-in: costs an extra provider round-trip per step.
 *
 * mode "off"        — no verification (default)
 * mode "per-step"   — auto-invoke the configured verifier after each completed step
 * mode "on-failure" — invoke only when the agent's tool call returned an error
 *
 * verifier defaults to config.roles.adjudicator when undefined.
 * timeoutMs defaults to 5000 (milliseconds to wait for a verdict before proceeding).
 * See ADR 0032.
 *
 * requireVerdictBeforeExit (ADR 0035): when true, endSession() will refuse to
 * complete unless at least one verdict (aligned/misaligned/uncertain/off-track/failed/partial)
 * was issued by the Adjudicator in the current session. Default: false (back-compat).
 * This is distinct from the existing aligned-verdict gate (ADR 0012): that gate
 * checks the verdict KIND; this gate checks that ANY verdict was issued at all.
 * Both can be active simultaneously. The check is skipped when trustMode is "implicit".
 */
export interface VerificationConfig {
  readonly mode: "off" | "per-step" | "on-failure";
  /** AgentId of the verifier; defaults to KernelConfig.roles.adjudicator. */
  readonly verifier?: AgentId;
  /** Milliseconds to wait for a verdict before proceeding. Default: 5000. */
  readonly timeoutMs?: number;
  /**
   * ADR 0035: when true, endSession() refuses to complete unless at least one
   * verdict was issued by the Adjudicator in this session. Default: false.
   */
  readonly requireVerdictBeforeExit?: boolean;
}

export interface KernelDeps {
  modeRegistry?: ModeRegistry | undefined;
  toolRegistry?: ToolRegistry | undefined;
  recorder?: SessionRecorder | undefined;
  costMeter?: CostMeter | undefined;
  lineageGuard?: LineageGuard | undefined;
  bus?: Bus | undefined;
  telemetry?: Telemetry | undefined;
  workspaceManager?: WorkspaceManager | undefined;
  memory?: Memory | undefined;
  sandbox?: Sandbox | undefined;
  surveillance?: Surveillance | undefined;
  /** M3b: opt-in post-step verification via the Adjudicator role. */
  verification?: VerificationConfig | undefined;
  /**
   * Used when reproducibility === "record-replay".
   *
   * The kernel cannot depend on @emerge/replay (circular dep).  Instead the
   * caller passes a pre-constructed SessionRecord that the kernel uses to
   * build a Provider wrapper via `replayProviderFactory`.  If only
   * `replayRecord` is provided and no `replayProviderFactory`, the kernel
   * returns E_NO_REPLAY_RECORD when a provider call would be made.
   *
   * Typical usage (from examples/replay-smoke):
   *
   *   import { RecordedProvider } from "@emerge/replay";
   *   deps.replayRecord = record;
   *   deps.replayProviderFactory = (rec, caps) => new RecordedProvider(rec, caps);
   */
  replayRecord?: SessionRecord | undefined;
  /**
   * Factory that wraps a SessionRecord + original ProviderCapabilities into a
   * replay-faithful Provider.  Supplied by the caller so the kernel stays
   * free of @emerge/replay as a runtime dependency.
   */
  replayProviderFactory?:
    | ((record: SessionRecord, originalProvider: Provider) => Provider)
    | undefined;
}

// Simple in-memory tool registry
class SimpleToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    // C5: reject duplicate tool names with a typed error instead of silently overwriting
    if (this.tools.has(tool.spec.name)) {
      throw Object.assign(
        new Error(
          `Tool "${tool.spec.name}" is already registered. Duplicate tool names are not allowed.`,
        ),
        { code: "E_TOOL_DUPLICATE" },
      );
    }
    this.tools.set(tool.spec.name, tool);
  }
  unregister(name: string): void {
    this.tools.delete(name);
  }
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
  resolve(allow: readonly string[]): readonly Tool[] {
    if (allow.length === 0) return [];
    return allow.map((n) => this.tools.get(n)).filter((t): t is Tool => t !== undefined);
  }
  list(): readonly ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }
}

// Simple in-memory memory
class SimpleMemory implements Memory {
  private readonly items: MemoryItem[] = [];
  private counter = 0;

  async append(
    rawItems: readonly Omit<MemoryItem, "id" | "createdAt">[],
  ): Promise<Result<readonly string[]>> {
    const ids: string[] = [];
    for (const item of rawItems) {
      const id = `m${++this.counter}`;
      this.items.push({ ...item, id, createdAt: Date.now() } as MemoryItem);
      ids.push(id);
    }
    return { ok: true, value: ids };
  }

  async recall(
    query: RecallQuery,
    scope: RecallScope,
    budget: RecallBudget,
  ): Promise<Result<RecallResult>> {
    // F: Separate pinned items — they are ALWAYS included regardless of budget.
    // Future compressors MUST NOT drop items with `pin` set.
    const pinnedItems = this.items.filter((item) => item.pin !== undefined);
    let nonPinned = this.items.filter((item) => item.pin === undefined);

    // M12: honour scope.agents and query.attributes filters (applied to non-pinned only;
    // pinned items survive scope filtering by design — ADR 0016)
    if (scope.agents && scope.agents.length > 0) {
      const agentSet = new Set<string>(scope.agents);
      nonPinned = nonPinned.filter((item) => {
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
        const itemAgent = item.attributes["agent"];
        return itemAgent !== undefined && agentSet.has(String(itemAgent));
      });
    }

    if (query.attributes && Object.keys(query.attributes).length > 0) {
      nonPinned = nonPinned.filter((item) =>
        Object.entries(query.attributes ?? {}).every(([k, v]) => item.attributes[k] === v),
      );
    }

    const maxItems = budget.maxItems ?? nonPinned.length;
    const selectedNonPinned = nonPinned.slice(-maxItems);
    const droppedForBudget = Math.max(0, nonPinned.length - maxItems);

    // Pinned items are always first; non-pinned follow
    const items = [...pinnedItems, ...selectedNonPinned];

    // Build trace entries for pinned items
    const traceItems = pinnedItems.map((item) => ({
      itemId: item.id,
      score: 1.0,
      components: {} as Readonly<{
        semantic?: number;
        structural?: number;
        temporal?: number;
        causal?: number;
      }>,
      reason: `pinned:${item.pin ?? "unknown"}`,
    }));

    return {
      ok: true,
      value: {
        items,
        trace: { items: traceItems, droppedForBudget },
      },
    };
  }

  async get(id: string): Promise<Result<MemoryItem | undefined>> {
    return { ok: true, value: this.items.find((i) => i.id === id) };
  }

  async retier(_id: string, _to: MemoryTier): Promise<Result<void, ContractError>> {
    return { ok: true, value: undefined };
  }
}

// No-op sandbox (allow all)
class NoopSandbox implements Sandbox {
  async authorize(_req: SandboxRequest): Promise<Result<SandboxDecision>> {
    return { ok: true, value: { kind: "allow" } };
  }
  async run<T>(_req: SandboxRequest, fn: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return { ok: false, error: { code: "E_SANDBOX", message: String(err) } };
    }
  }
}

function validateTerminationPolicy(p: TerminationPolicy): Result<void> {
  if (p.maxIterations < 1) {
    return {
      ok: false,
      error: {
        code: "E_INVALID_TERMINATION",
        message: `maxIterations must be >= 1, got ${p.maxIterations}`,
      },
    };
  }
  if (p.maxWallMs < 1) {
    return {
      ok: false,
      error: {
        code: "E_INVALID_TERMINATION",
        message: `maxWallMs must be >= 1, got ${p.maxWallMs}`,
      },
    };
  }
  if (p.cycle.windowSize < 1) {
    return {
      ok: false,
      error: {
        code: "E_INVALID_TERMINATION",
        message: `cycle.windowSize must be >= 1, got ${p.cycle.windowSize}`,
      },
    };
  }
  if (p.cycle.repeatThreshold < 1) {
    return {
      ok: false,
      error: {
        code: "E_INVALID_TERMINATION",
        message: `cycle.repeatThreshold must be >= 1, got ${p.cycle.repeatThreshold}`,
      },
    };
  }
  if (p.retry.transient < 0) {
    return {
      ok: false,
      error: {
        code: "E_INVALID_TERMINATION",
        message: `retry.transient must be >= 0, got ${p.retry.transient}`,
      },
    };
  }
  return { ok: true, value: undefined };
}

export class Kernel {
  private readonly config: KernelConfig;
  private readonly bus: Bus;
  private readonly scheduler: Scheduler;
  private readonly lineageGuard: LineageGuard;
  private readonly costMeter: CostMeter;
  private readonly toolRegistry: ToolRegistry;
  private memory: Memory;
  private sandbox: Sandbox;
  private surveillance: Surveillance | undefined;
  private experienceLibrary: ExperienceLibrary | undefined;
  /** C: Postmortem analyzer — invoked after endSession() if also an ExperienceLibrary is mounted. */
  private postmortem: Postmortem | undefined;
  /** D: mounted in-process Custodian for quota auto-routing. */
  private custodian: Custodian | undefined;
  /** D: quota router subscription cleanup — active when custodian is mounted. */
  private quotaRouterCleanup: (() => void) | undefined;
  private readonly deps: KernelDeps;
  private readonly providers = new Map<string, Provider>();
  private sessionId: SessionId = `sess-${Date.now()}` as SessionId;
  private contractId: ContractId = "contract-default" as ContractId;
  private readonly handles = new Map<AgentId, AgentHandle>();
  /**
   * C1: Track the latest verdict per session from the configured adjudicator.
   * Only used when trustMode !== "implicit".
   */
  private _latestVerdict: Verdict | undefined = undefined;
  private _verdictSubscriptionCleanup: (() => void) | undefined = undefined;
  /** C1: One-time warn flag — emitted when no adjudicator is configured. */
  private _warnedNoAdjudicator = false;
  /** M3b: schema adapter registry — adapts ToolSpec JSON schemas per provider. */
  private readonly schemaAdapterRegistry = new SchemaAdapterRegistry();

  constructor(config: KernelConfig, deps: KernelDeps = {}) {
    if (config.lineage.maxDepth < 1) {
      throw new Error(`LineageGuardConfig.maxDepth must be >= 1, got ${config.lineage.maxDepth}`);
    }
    this.config = config;
    this.deps = deps;
    this.bus = deps.bus ?? new InMemoryBus(config.bus, config.roles);
    this.scheduler = new Scheduler(this.bus);
    this.lineageGuard = deps.lineageGuard ?? new InMemoryLineageGuard(config.lineage);
    this.costMeter = deps.costMeter ?? new InMemoryCostMeter();
    this.toolRegistry = deps.toolRegistry ?? new SimpleToolRegistry();
    this.memory = deps.memory ?? new SimpleMemory();
    this.sandbox = deps.sandbox ?? new NoopSandbox();
    this.surveillance = deps.surveillance;
  }

  mountProvider(provider: Provider): void {
    this.providers.set(provider.capabilities.id, provider);
  }

  /**
   * Attach an experience library so surveillance can use historical hints as priors.
   * Without a mounted library, experienceHints are undefined — which is honest.
   */
  mountExperienceLibrary(library: ExperienceLibrary): void {
    this.experienceLibrary = library;
  }

  /**
   * C: Attach a Postmortem analyzer. When both a Postmortem AND an ExperienceLibrary
   * are mounted, endSession() automatically invokes postmortem.analyze(record) after
   * the SessionRecord is finalized, then library.ingest() for each emitted Experience.
   * Errors from these steps are returned as additional fields on the result; not thrown.
   * See ADR 0019.
   */
  mountPostmortem(postmortem: Postmortem): void {
    this.postmortem = postmortem;
  }

  mountSurveillance(s: Surveillance): void {
    this.surveillance = s;
  }

  mountSandbox(s: Sandbox): void {
    this.sandbox = s;
  }

  mountMemory(m: Memory): void {
    this.memory = m;
  }

  /**
   * M3b: Register a per-provider JSON schema adapter.
   * The adapter is applied when serializing tool specs for provider invocations.
   * Pass the provider id this adapter targets (e.g. "anthropic", "mock").
   * Use SchemaAdapterRegistry.adapt() directly for advanced routing.
   */
  mountSchemaAdapter(
    providerId: string,
    adapter: import("./schema-adapter.js").SchemaAdapter,
  ): void {
    this.schemaAdapterRegistry.mount(providerId, adapter);
  }

  /** M3b: Expose the adapter registry for the agent-runner. */
  getSchemaAdapterRegistry(): SchemaAdapterRegistry {
    return this.schemaAdapterRegistry;
  }

  /**
   * D: Register an in-process Custodian for quota auto-routing.
   * When a `quota.request` envelope is sent on the bus to the configured
   * custodian id, the kernel intercepts it, calls custodian.receiveQuotaRequest(),
   * and replies with the appropriate quota.grant/deny/partial envelope.
   *
   * KernelConfig.roles.custodian must be set to the custodian's AgentId for
   * this to be effective.
   */
  mountCustodian(custodian: Custodian): void {
    this.custodian = custodian;
    this.startQuotaAutoRouter();
  }

  private startQuotaAutoRouter(): void {
    const custodianId = this.config.roles.custodian;
    if (!custodianId || !this.custodian) return;

    // Clean up previous subscription if any
    this.quotaRouterCleanup?.();

    const custodian = this.custodian;
    const bus = this.bus;
    const sessionId = this.sessionId;
    let active = true;

    // Subscribe as custodian to receive quota.request envelopes addressed to it
    const sub = bus.subscribe(custodianId, { kind: "self" });

    void (async () => {
      for await (const env of sub.events) {
        if (!active) break;
        if (env.kind !== "quota.request") continue;

        const req = env.request;
        const decision = await custodian.receiveQuotaRequest(req);

        const decisionKind: "quota.grant" | "quota.deny" | "quota.partial" =
          decision.kind === "grant"
            ? "quota.grant"
            : decision.kind === "deny"
              ? "quota.deny"
              : "quota.partial";

        await bus.send({
          kind: decisionKind,
          correlationId: env.correlationId,
          sessionId,
          from: custodianId,
          to: { kind: "agent", id: env.from },
          timestamp: Date.now(),
          decision,
        });
      }
    })();

    this.quotaRouterCleanup = () => {
      active = false;
      sub.close();
    };
  }

  /**
   * D: Create a QuotaRouter pre-wired to this kernel's custodian.
   * Returns undefined if no custodian is configured.
   */
  getQuotaRouter(): QuotaRouter | undefined {
    const custodianId = this.config.roles.custodian;
    if (!custodianId) return undefined;
    return new QuotaRouter(this.bus, custodianId);
  }

  /**
   * Set the active session + contract, and auto-start the recorder if one is
   * attached.  Callers no longer need to call recorder.start() separately.
   */
  setSession(sessionId: SessionId, contractId: ContractId): void {
    this.sessionId = sessionId;
    this.contractId = contractId;
    // Reset verdict tracking for the new session
    this._latestVerdict = undefined;
    // M7: auto-start the recorder so callers don't have to
    this.deps.recorder?.start(sessionId, contractId);
    // D: restart quota auto-router with the new sessionId if custodian is mounted
    if (this.custodian) {
      this.startQuotaAutoRouter();
    }
    // C1: start adjudicator verdict subscription
    this.startVerdictSubscription();
  }

  /**
   * C1: Subscribe to verdict envelopes from the configured adjudicator.
   * Tracks the latest verdict per session for endSession() enforcement.
   */
  private startVerdictSubscription(): void {
    // Clean up previous subscription
    this._verdictSubscriptionCleanup?.();
    this._verdictSubscriptionCleanup = undefined;

    const adjudicatorId = this.config.roles.adjudicator;
    if (!adjudicatorId) return;

    const bus = this.bus;
    let active = true;

    // Subscribe as kernel observer to verdict envelopes from the adjudicator
    const sub = bus.subscribe("kernel" as AgentId, {
      kind: "from",
      sender: adjudicatorId,
      kinds: ["verdict"],
    });

    void (async () => {
      for await (const env of sub.events) {
        if (!active) break;
        if (env.kind !== "verdict") continue;
        this._latestVerdict = env.verdict;
      }
    })();

    this._verdictSubscriptionCleanup = () => {
      active = false;
      sub.close();
    };
  }

  async spawn(spec: AgentSpec): Promise<Result<AgentHandle>> {
    // C4: validate TerminationPolicy
    const policyCheck = validateTerminationPolicy(spec.termination);
    if (!policyCheck.ok) return policyCheck;

    // Lineage check
    if (spec.lineage.spawnedBy) {
      const canResult = this.lineageGuard.canSpawn(spec.lineage.spawnedBy, spec.id);
      if (!canResult.ok) return canResult;
    }

    // Resolve provider
    const providerId =
      spec.provider.kind === "static" ? spec.provider.providerId : spec.provider.preference[0];

    if (!providerId) {
      return { ok: false, error: { code: "E_NO_PROVIDER", message: "no provider available" } };
    }

    const rawProvider = this.providers.get(providerId);
    if (!rawProvider) {
      return {
        ok: false,
        error: { code: "E_PROVIDER_NOT_FOUND", message: `provider ${providerId} not found` },
      };
    }

    // C1: record-replay tier — substitute RecordedProvider (via factory to avoid circular dep)
    let provider: Provider = rawProvider;
    if (this.config.reproducibility === "record-replay") {
      const record = this.deps.replayRecord;
      if (!record) {
        return {
          ok: false,
          error: {
            code: "E_NO_REPLAY_RECORD",
            message:
              "reproducibility is 'record-replay' but no replayRecord was provided in KernelDeps",
          },
        };
      }
      const factory = this.deps.replayProviderFactory;
      if (!factory) {
        return {
          ok: false,
          error: {
            code: "E_NO_REPLAY_RECORD",
            message:
              "reproducibility is 'record-replay' but no replayProviderFactory was provided in KernelDeps",
          },
        };
      }
      provider = factory(record, rawProvider);
    }

    // Record lineage
    if (spec.lineage.spawnedBy) {
      const edge: LineageEdge = {
        parent: spec.lineage.spawnedBy,
        child: spec.id,
        at: Date.now(),
      };
      this.lineageGuard.record(edge);
    }

    const correlationId = `agent-${spec.id}-${Date.now()}` as CorrelationId;

    // Notify hook for CalibratedSurveillance (or any impl that exposes notifyAssessment)
    const survInst = this.surveillance;
    const surveillanceNotify =
      survInst && "notifyAssessment" in survInst
        ? (
            survInst as unknown as {
              notifyAssessment: (agentId: string, providerId: string, difficulty: string) => void;
            }
          ).notifyAssessment.bind(survInst)
        : undefined;

    const runner = new AgentRunner({
      spec,
      provider,
      toolRegistry: this.toolRegistry,
      sandbox: this.sandbox,
      memory: this.memory,
      bus: this.bus,
      scheduler: this.scheduler,
      sessionId: this.sessionId,
      correlationId,
      contractId: this.contractId,
      telemetry: this.deps.telemetry,
      recorder: this.deps.recorder,
      costMeter: this.costMeter,
      surveillance: this.surveillance,
      surveillanceNotify,
      lineageMaxDepth: this.config.lineage.maxDepth,
      experienceLibrary: this.experienceLibrary,
      schemaAdapterRegistry: this.schemaAdapterRegistry,
      verification: this.deps.verification,
      adjudicatorId: this.config.roles.adjudicator,
      sessionMode: this.config.mode,
    });

    this.handles.set(spec.id, runner);

    // C1/C2: open inbox + quota subscriptions NOW, before returning the handle.
    // This ensures any bus.send(request, id) that the caller fires after spawn()
    // is buffered in the runner's queue and not lost.
    runner.openInbox();

    // C2: register the agent's card in the bus so ACL can be enforced
    if (this.bus instanceof InMemoryBus) {
      this.bus.registerCard(runner.card());
      // Mn5: unregister the card when the agent emits a terminal result envelope
      this.watchForTerminalResult(spec.id);
    }

    // Perform handshake
    await this.bus.send({
      kind: "handshake",
      correlationId,
      sessionId: this.sessionId,
      from: spec.id,
      to: { kind: "broadcast" },
      timestamp: Date.now(),
      card: runner.card(),
    });

    if (this.deps.recorder) {
      this.deps.recorder.record({
        kind: "lifecycle",
        at: Date.now(),
        agent: spec.id,
        transition: "idle",
      });
    }

    if (this.deps.telemetry) {
      const spanId = `spawn-${spec.id}` as SpanId;
      this.deps.telemetry.start({
        id: spanId,
        kind: "agent_spawn",
        name: `spawn:${spec.id}`,
        agent: spec.id,
        startedAt: Date.now(),
      });
      this.deps.telemetry.end({ id: spanId, endedAt: Date.now(), status: "ok" });
    }

    return { ok: true, value: runner };
  }

  /**
   * Mn5: Subscribe to a single agent's result envelope and unregister its card
   * when the terminal result arrives. Belt-and-braces alongside endSession.
   */
  private watchForTerminalResult(agentId: AgentId): void {
    const bus = this.bus;
    if (!(bus instanceof InMemoryBus)) return;
    const sub = bus.subscribe("kernel" as AgentId, {
      kind: "from",
      sender: agentId,
      kinds: ["result"],
    });
    void (async () => {
      for await (const env of sub.events) {
        if (env.kind === "result") {
          bus.unregisterCard(agentId);
          sub.close();
          break;
        }
      }
    })();
  }

  async dispatch(envelope: BusEnvelope): Promise<Result<void>> {
    return this.bus.send(envelope);
  }

  async runAgent(handle: AgentHandle): Promise<void> {
    if (handle instanceof AgentRunner) {
      await handle.run();
    }
  }

  /** M1: Structured result for endSession — carries the session record plus any
   *  non-fatal postmortem errors so callers can observe them rather than relying
   *  on console.warn alone. */
  async endSession(): Promise<
    Result<{ record: SessionRecord | undefined; postmortemErrors?: ContractError[] }>
  > {
    // C1: Enforce adjudicator verdict gate unless trustMode is "implicit".
    const trustMode = this.config.trustMode ?? "explicit";
    const adjudicatorId = this.config.roles.adjudicator;

    if (trustMode !== "implicit") {
      if (!adjudicatorId) {
        // No adjudicator configured — trust is implied, but warn once.
        if (!this._warnedNoAdjudicator) {
          this._warnedNoAdjudicator = true;
          console.warn(
            "[emerge/kernel] endSession: no adjudicator configured — session will complete without verdict gating. Set config.roles.adjudicator to enforce ADR 0012.",
          );
        }
      } else {
        // ADR 0035: requireVerdictBeforeExit gate — check that ANY verdict was issued.
        // This is distinct from the ADR 0012 aligned-kind check below.
        // Both can be active: this one fires first with a more informative error code.
        if (this.deps.verification?.requireVerdictBeforeExit && this._latestVerdict === undefined) {
          this._verdictSubscriptionCleanup?.();
          return {
            ok: false,
            error: {
              code: "E_NO_VERIFICATION_CALLED",
              message: `Session cannot exit: the Adjudicator at id=${adjudicatorId} never issued a verdict for this session — call request_verification or set requireVerdictBeforeExit=false to bypass.`,
            },
          };
        }

        // ADR 0012: aligned-verdict gate — check that the verdict kind is "aligned".
        if (this._latestVerdict?.kind !== "aligned") {
          // Adjudicator is configured but hasn't issued an aligned verdict.
          this._verdictSubscriptionCleanup?.();
          return {
            ok: false,
            error: {
              code: "E_NO_ALIGNED_VERDICT",
              message: `Session cannot be marked completed: adjudicator has not issued an 'aligned' verdict (latest: ${this._latestVerdict?.kind ?? "none"}). Emit an 'aligned' verdict from the adjudicator before ending the session, or set config.trustMode: "implicit" to bypass.`,
            },
          };
        }
      }
    }

    // Clean up verdict subscription
    this._verdictSubscriptionCleanup?.();
    this._verdictSubscriptionCleanup = undefined;

    let record: SessionRecord | undefined;
    if (this.deps.recorder) {
      const recResult = await this.deps.recorder.end(this.sessionId);
      if (!recResult.ok) return recResult;
      record = recResult.value;
    }

    // M1: Warn once when only one of (Postmortem, ExperienceLibrary) is mounted.
    // Both are required for auto-invoke to fire; a mismatch is almost certainly
    // a misconfiguration and should be visible at session-end.
    if (this.postmortem !== undefined && this.experienceLibrary === undefined) {
      console.warn(
        "[emerge/kernel] endSession: Postmortem mounted without ExperienceLibrary; auto-invoke disabled. Mount an ExperienceLibrary to enable postmortem→ingest wiring (ADR 0019).",
      );
    } else if (this.postmortem === undefined && this.experienceLibrary !== undefined) {
      console.warn(
        "[emerge/kernel] endSession: ExperienceLibrary mounted without Postmortem; auto-invoke disabled. Mount a Postmortem to enable postmortem→ingest wiring (ADR 0019).",
      );
    }

    // C: ADR 0019 — auto-invoke Postmortem + ExperienceLibrary ingest after session ends.
    // Errors are non-fatal: returned as postmortemErrors so callers can observe them;
    // the session record is still committed regardless.
    const postmortemErrors: ContractError[] = [];

    if (
      this.postmortem !== undefined &&
      this.experienceLibrary !== undefined &&
      record !== undefined
    ) {
      const pm = this.postmortem;
      const lib = this.experienceLibrary;

      const analyzeResult = await pm.analyze(record);
      if (!analyzeResult.ok) {
        postmortemErrors.push({
          code: "E_POSTMORTEM_ANALYZE",
          message: `postmortem.analyze: ${analyzeResult.error.message}`,
        });
      } else {
        for (const exp of analyzeResult.value) {
          const ingestResult = await lib.ingest(exp);
          if (!ingestResult.ok) {
            postmortemErrors.push({
              code: "E_POSTMORTEM_INGEST",
              message: `library.ingest(${exp.id}): ${ingestResult.error.message}`,
            });
          }
        }
      }
    }

    return {
      ok: true,
      value: {
        record,
        ...(postmortemErrors.length > 0 ? { postmortemErrors } : {}),
      },
    };
  }

  getBus(): Bus {
    return this.bus;
  }

  /** C2: Expose shared kernel Memory so callers (e.g. Custodian) can write into it. */
  getMemory(): Memory {
    return this.memory;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getCostMeter(): CostMeter {
    return this.costMeter;
  }
}
