/**
 * Kernel — the top-level facade. Constructor takes KernelConfig + optional modules.
 */

import type { CostMeter } from "../contracts/cost.js";
import type { Custodian } from "../contracts/custodian.js";
import type { ExperienceLibrary } from "../contracts/experience.js";
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
  /** D: mounted in-process Custodian for quota auto-routing. */
  private custodian: Custodian | undefined;
  /** D: quota router subscription cleanup — active when custodian is mounted. */
  private quotaRouterCleanup: (() => void) | undefined;
  private readonly deps: KernelDeps;
  private readonly providers = new Map<string, Provider>();
  private sessionId: SessionId = `sess-${Date.now()}` as SessionId;
  private contractId: ContractId = "contract-default" as ContractId;
  private readonly handles = new Map<AgentId, AgentHandle>();

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

  mountSurveillance(s: Surveillance): void {
    // surveillance is wired; assess()/observe() are not yet called from the
    // loop (deferred to M2).
    this.surveillance = s;
  }

  mountSandbox(s: Sandbox): void {
    this.sandbox = s;
  }

  mountMemory(m: Memory): void {
    this.memory = m;
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
    // M7: auto-start the recorder so callers don't have to
    this.deps.recorder?.start(sessionId, contractId);
    // D: restart quota auto-router with the new sessionId if custodian is mounted
    if (this.custodian) {
      this.startQuotaAutoRouter();
    }
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
    });

    this.handles.set(spec.id, runner);

    // C2: register the agent's card in the bus so ACL can be enforced
    if (this.bus instanceof InMemoryBus) {
      this.bus.registerCard(runner.card());
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

  async dispatch(envelope: BusEnvelope): Promise<Result<void>> {
    return this.bus.send(envelope);
  }

  async runAgent(handle: AgentHandle): Promise<void> {
    if (handle instanceof AgentRunner) {
      await handle.run();
    }
  }

  async endSession(): Promise<Result<SessionRecord | undefined>> {
    if (this.deps.recorder) {
      return this.deps.recorder.end(this.sessionId);
    }
    return { ok: true, value: undefined };
  }

  getBus(): Bus {
    return this.bus;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getCostMeter(): CostMeter {
    return this.costMeter;
  }
}
