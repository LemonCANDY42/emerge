/**
 * Kernel — the top-level facade. Constructor takes KernelConfig + optional modules.
 */

import type { CostMeter } from "../contracts/cost.js";
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
import { AgentRunner } from "./agent-runner.js";
import { InMemoryBus } from "./bus.js";
import { InMemoryCostMeter } from "./cost-meter.js";
import { InMemoryLineageGuard } from "./lineage-guard.js";
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
    _query: RecallQuery,
    _scope: RecallScope,
    budget: RecallBudget,
  ): Promise<Result<RecallResult>> {
    const maxItems = budget.maxItems ?? this.items.length;
    const items = this.items.slice(-maxItems);
    return {
      ok: true,
      value: {
        items,
        trace: { items: [], droppedForBudget: Math.max(0, this.items.length - maxItems) },
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

export class Kernel {
  private readonly config: KernelConfig;
  private readonly bus: Bus;
  private readonly scheduler: Scheduler;
  private readonly lineageGuard: LineageGuard;
  private readonly costMeter: CostMeter;
  private readonly toolRegistry: ToolRegistry;
  private readonly memory: Memory;
  private readonly sandbox: Sandbox;
  private readonly deps: KernelDeps;
  private readonly providers = new Map<string, Provider>();
  private sessionId: SessionId = `sess-${Date.now()}` as SessionId;
  private contractId: ContractId = "contract-default" as ContractId;
  private readonly handles = new Map<AgentId, AgentHandle>();

  constructor(config: KernelConfig, deps: KernelDeps = {}) {
    this.config = config;
    this.deps = deps;
    this.bus = deps.bus ?? new InMemoryBus(config.bus);
    this.scheduler = new Scheduler(this.bus);
    this.lineageGuard = deps.lineageGuard ?? new InMemoryLineageGuard(config.lineage);
    this.costMeter = deps.costMeter ?? new InMemoryCostMeter();
    this.toolRegistry = deps.toolRegistry ?? new SimpleToolRegistry();
    this.memory = deps.memory ?? new SimpleMemory();
    this.sandbox = deps.sandbox ?? new NoopSandbox();
  }

  mountProvider(provider: Provider): void {
    this.providers.set(provider.capabilities.id, provider);
  }

  mountSurveillance(_s: Surveillance): void {
    // stored for future use
  }

  mountSandbox(s: Sandbox): void {
    // if explicitly mounted, override; for now stored in deps
    void s;
  }

  mountMemory(m: Memory): void {
    void m;
  }

  setSession(sessionId: SessionId, contractId: ContractId): void {
    this.sessionId = sessionId;
    this.contractId = contractId;
  }

  async spawn(spec: AgentSpec): Promise<Result<AgentHandle>> {
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

    const provider = this.providers.get(providerId);
    if (!provider) {
      return {
        ok: false,
        error: { code: "E_PROVIDER_NOT_FOUND", message: `provider ${providerId} not found` },
      };
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

    const sandbox = this.deps.sandbox ?? this.sandbox;
    const memory = this.deps.memory ?? this.memory;

    const runner = new AgentRunner({
      spec,
      provider,
      toolRegistry: this.toolRegistry,
      sandbox,
      memory,
      bus: this.bus,
      scheduler: this.scheduler,
      sessionId: this.sessionId,
      correlationId,
      telemetry: this.deps.telemetry,
      recorder: this.deps.recorder,
    });

    this.handles.set(spec.id, runner);

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
