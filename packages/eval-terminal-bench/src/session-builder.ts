/**
 * session-builder — constructs a Kernel wired for Terminal-Bench task execution.
 *
 * Wires: provider + tools (fs.read, fs.write, bash) + adjudicator +
 * workspace-scoped sandbox. The caller is responsible for spawning the
 * agent spec and calling endSession().
 *
 * ## Tool registry scoping (Critical #4 fix)
 *
 * The kernel's getToolRegistry() returns a SHARED registry — it is the same
 * object across all sessions on that kernel instance. Registering auto-wrapped
 * tools into it would mean that every future session created from the same
 * kernel loses interactive permission gating. Instead, buildSession creates a
 * session-scoped registry, registers the wrapped tools into it, and passes it
 * via KernelDeps.toolRegistry when constructing the kernel. The scoped registry
 * is private to this session; other kernels and sessions are unaffected.
 */

import { buildAdjudicator } from "@lwrf42/emerge-agents";
import type {
  AgentId,
  ContractId,
  EvaluationInput,
  Provider,
  SessionId,
  SessionRecorder,
  Tool,
  ToolSpec,
  Verdict,
} from "@lwrf42/emerge-kernel/contracts";
import type { ToolRegistry } from "@lwrf42/emerge-kernel/contracts";
import { Kernel } from "@lwrf42/emerge-kernel/runtime";
import type { KernelDeps, SchemaAdapter } from "@lwrf42/emerge-kernel/runtime";
import { HarborSandbox } from "@lwrf42/emerge-sandbox-harbor";
import { InProcSandbox } from "@lwrf42/emerge-sandbox-inproc";
import { CalibratedSurveillance } from "@lwrf42/emerge-surveillance";
import { makeBashTool, makeFsReadTool, makeFsWriteTool } from "@lwrf42/emerge-tools";
import type { AcceptanceSandbox } from "./acceptance-runner.js";
import { makeAcceptanceEvaluator } from "./acceptance-runner.js";
import type { TaskSpec } from "./task-loader.js";

// ─── Session-scoped tool registry ────────────────────────────────────────────

/**
 * A minimal ToolRegistry implementation scoped to a single session.
 * Unlike the kernel's shared registry, this one is constructed per-session
 * and passed in via KernelDeps.toolRegistry so it never leaks to other sessions.
 */
class SessionToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.spec.name)) {
      throw Object.assign(
        new Error(`Tool "${tool.spec.name}" already registered in this session registry`),
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

// ─── Session builder options ─────────────────────────────────────────────────

export type SandboxMode = "inproc" | "harbor";

export interface SessionBuilderOptions {
  readonly spec: TaskSpec;
  readonly workspaceRoot: string;
  /** Provider to mount on the kernel. Required. */
  readonly provider: Provider;
  /** Which sandbox to use for tool execution. Default: "inproc". */
  readonly sandboxMode?: SandboxMode;
  /** Docker image for Harbor sandbox. Default: "ubuntu:22.04". */
  readonly harborImage?: string;
  /** Session id (generated if omitted). */
  readonly sessionId?: SessionId;
  /**
   * Sandbox to use for running the acceptance command.
   * Default: { kind: "host" } for inproc mode (back-compat).
   * For harbor mode, set to { kind: "harbor"; image: harborImage } to run
   * acceptance in a fresh read-only container — prevents agent tamper.
   * See acceptance-runner.ts trust model docs.
   */
  readonly acceptanceSandbox?: AcceptanceSandbox;
  /**
   * JSON schema adapter for the provider.
   * Different providers (OpenAI, Anthropic) require different JSON schema
   * shapes for tool specs. Pass the provider-specific adapter so tool schemas
   * are correctly adapted before being sent to the model.
   *
   * For OpenAI: import { openaiSchemaAdapter } from "@lwrf42/emerge-provider-openai"
   * For Anthropic: import { anthropicSchemaAdapter } from "@lwrf42/emerge-provider-anthropic"
   * For MockProvider (tests): omit — no adapter needed.
   */
  readonly schemaAdapter?: SchemaAdapter;
  /**
   * Optional session recorder. When provided, the kernel will record all
   * provider_call events as they occur. Call endSession() and inspect
   * result.value.record to retrieve the SessionRecord for replay.
   *
   * Used by tbench-real-replay to record Phase 1 for later replay via
   * RecordedProvider without incurring real API costs.
   */
  readonly recorder?: SessionRecorder | undefined;
  /**
   * Session record for replay (from a prior Phase 1 recording).
   * When provided alongside replayProviderFactory, sets the kernel to
   * reproducibility:"record-replay" and routes all provider.invoke() calls
   * through the RecordedProvider, replaying events without real API calls.
   *
   * Used by tbench-real-replay Phase 2.
   */
  readonly replayRecord?: import("@lwrf42/emerge-kernel/contracts").SessionRecord | undefined;
  /**
   * Factory that wraps a SessionRecord + original Provider into a replay
   * provider. Must be provided together with replayRecord.
   *
   * Example:
   *   import { RecordedProvider } from "@lwrf42/emerge-replay";
   *   replayProviderFactory: (rec, original) => new RecordedProvider(rec, original.capabilities)
   */
  readonly replayProviderFactory?:
    | ((
        record: import("@lwrf42/emerge-kernel/contracts").SessionRecord,
        originalProvider: Provider,
      ) => Provider)
    | undefined;
}

// ─── Built session handle ────────────────────────────────────────────────────

export interface BuiltSession {
  readonly kernel: Kernel;
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly adjudicatorId: AgentId;
  /**
   * Stop the adjudicator's bus subscription. Returns a Promise that resolves
   * AFTER any in-flight evaluate()+verdict-send pair completes, so a subsequent
   * `kernel.endSession()` will see the verdict on `_latestVerdict`. Without
   * awaiting this, endSession may race with the verdict envelope and produce
   * spurious E_NO_ALIGNED_VERDICT errors.
   */
  stopAdjudicatorWatch(): Promise<void>;
  /** Last verdict emitted by the adjudicator (set after runAcceptance is called). */
  getLastVerdict(): Verdict | undefined;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wrap a Tool to override its permission.defaultMode to "auto".
 *
 * The agent-runner checks permission.defaultMode BEFORE calling sandbox.run().
 * Tools with defaultMode:"ask" (e.g. fs.write, bash) emit a human.request and
 * wait 60 seconds — blocking automated eval runs. For tbench sessions the
 * sandbox policy provides the real guard; we override defaultMode so the
 * agent-runner passes through immediately.
 *
 * NOTE: This wrapped tool is registered in a SESSION-SCOPED registry (not the
 * kernel's shared registry), so it does not affect other sessions or kernels.
 */
function withAutoPermission(tool: Tool): Tool {
  return {
    ...tool,
    spec: {
      ...tool.spec,
      permission: { ...tool.spec.permission, defaultMode: "auto" },
    },
  };
}

// ─── Build ───────────────────────────────────────────────────────────────────

/**
 * Build a kernel session configured for a Terminal-Bench task.
 *
 * The returned BuiltSession still requires the caller to:
 *   1. Build an AgentSpec and call `kernel.spawn(agentSpec)`
 *   2. Call `kernel.runAgent(handle)` to run the agent loop
 *   3. Call `stopAdjudicatorWatch()` then `kernel.endSession()`
 */
export function buildSession(opts: SessionBuilderOptions): BuiltSession {
  const {
    spec,
    workspaceRoot,
    provider,
    sandboxMode = "inproc",
    harborImage,
    sessionId = `tbench-${spec.id}-${Date.now()}` as SessionId,
  } = opts;

  const agentId = "tbench-agent" as AgentId;
  const adjudicatorId = "tbench-adjudicator" as AgentId;
  const contractId = `tbench-${spec.id}` as ContractId;

  // Contract
  const contract = {
    id: contractId,
    goal: spec.goal,
    acceptanceCriteria: [
      { kind: "predicate" as const, description: `Run: ${spec.acceptanceCommand}` },
    ],
    inputs: [],
    outputs: [],
    constraints: [],
    hash: contractId,
  };

  // Sandbox
  const harborOpts =
    harborImage !== undefined
      ? { workspaceDir: workspaceRoot, image: harborImage }
      : { workspaceDir: workspaceRoot };

  // Tool-level sandbox policy: the real authorization gate for inproc mode.
  // For harbor mode, HarborSandbox provides Docker-based isolation for process_spawn;
  // FS and state effects run in-process. Network effects are denied at the tool level.
  const inprocPolicy: import("@lwrf42/emerge-kernel/contracts").PermissionPolicy = {
    fs: { read: "auto", write: "auto", delete: "deny" },
    net: { read: "deny", write: "deny" },
    process: { spawn: "auto", kill: "deny" },
    agent: { spawn: "deny", message: "deny" },
    tools: { allow: "all" },
    mcp: { servers: "all" },
  };

  // Bug 2 fix: separate the tool-level sandbox (used inside tool implementations)
  // from the kernel-level sandbox (mounted on the kernel for authorization).
  //
  // For harbor mode, the HarborSandbox is passed to the FS/bash tool factories.
  // Those tools handle Docker dispatch internally via their own sandbox.run() call.
  // If HarborSandbox were also mounted on the kernel, the agent-runner would wrap
  // each tool.invoke() in an outer sandbox.run({ effect: "process_spawn", target: toolName })
  // call — and HarborSandbox would then run "docker run ... bash -c toolName" (the tool
  // NAME, not the actual command), ignoring the fn() callback entirely. The real
  // command would never execute.
  //
  // The kernel-level sandbox is used only for authorization checks and the outer
  // sandbox.run() wrapper in agent-runner. An InProcSandbox with a fully-permissive
  // policy is correct here: the tool-level sandbox (inside each tool's invoke()) is
  // the real authorization gate. We must allow all effects at the kernel level so
  // that the agent-runner's authorization loop does not deny tools before they can
  // delegate to their own sandbox.
  const toolSandbox =
    sandboxMode === "harbor" ? new HarborSandbox(harborOpts) : new InProcSandbox(inprocPolicy);
  // kernelPolicy: allow all effects — real authorization is inside each tool's sandbox.
  const kernelPolicy: import("@lwrf42/emerge-kernel/contracts").PermissionPolicy = {
    fs: { read: "auto", write: "auto", delete: "auto" },
    net: { read: "auto", write: "auto" },
    process: { spawn: "auto", kill: "auto" },
    agent: { spawn: "auto", message: "auto" },
    tools: { allow: "all" },
    mcp: { servers: "all" },
  };
  // kernelSandbox: always InProcSandbox — does not re-dispatch tool calls to Docker.
  // The tool-level sandbox (toolSandbox) handles Docker dispatch for process_spawn.
  const kernelSandbox = new InProcSandbox(kernelPolicy);
  // Alias for clarity in tool registration below.
  const sandbox = toolSandbox;

  // Acceptance sandbox: default to host for inproc (back-compat), harbor for harbor mode.
  const acceptanceSandbox: AcceptanceSandbox =
    opts.acceptanceSandbox ??
    (sandboxMode === "harbor" && harborImage !== undefined
      ? { kind: "harbor", image: harborImage }
      : { kind: "host" });

  // Acceptance evaluator (command-based; ignores LLM output)
  const baseEvaluator = makeAcceptanceEvaluator(
    spec.acceptanceCommand,
    workspaceRoot,
    spec.timeoutSeconds,
    acceptanceSandbox,
  );

  // Track the last verdict for external inspection
  let lastVerdict: Verdict | undefined;
  const trackingEvaluator = async (input: EvaluationInput): Promise<Verdict> => {
    const v = await baseEvaluator(input);
    lastVerdict = v;
    return v;
  };

  // Adjudicator
  const { spec: adjSpec, watchBus } = buildAdjudicator({
    id: adjudicatorId,
    contract,
    evaluate: trackingEvaluator,
    resultSenders: [agentId],
    providerId: provider.capabilities.id,
  });

  // Session-scoped tool registry (Critical #4: do NOT use the kernel's shared registry).
  // Tools wrapped with auto-permission below are registered here only; they are
  // invisible to other sessions or kernels that might reuse the same provider.
  //
  // Bug 3 fix: pass baseDir so all relative (and absolute) paths are constrained
  // to the workspace root. Paths that escape via ".." or absolute prefixes outside
  // the workspace are rejected with E_PATH_ESCAPE before touching the filesystem.
  const fsOpts = { baseDir: workspaceRoot };
  const sessionToolRegistry = new SessionToolRegistry();
  sessionToolRegistry.register(withAutoPermission(makeFsReadTool(sandbox, fsOpts)));
  sessionToolRegistry.register(withAutoPermission(makeFsWriteTool(sandbox, fsOpts)));
  sessionToolRegistry.register(withAutoPermission(makeBashTool(sandbox)));

  // CalibratedSurveillance: no-op probes for synthetic tasks (ceiling: trivial).
  // Surveillance "active" profile means the hint loop fires before each step.
  // This satisfies the ADR 0035 claim without running real provider probe calls.
  // For production benches, run runProbesAsync() before buildSession to seed real data.
  const surveillance = new CalibratedSurveillance({
    maxDepth: 4,
    // Pre-seed envelope with trivial ceiling — accurate for MockProvider.
    // Real providers should call surveillance.runProbes(provider) or
    // surveillance.runProbesAsync(provider) before session start.
    envelope: new Map([
      [provider.capabilities.id, { probeSuccessRate: 0.9, lastUpdatedAt: Date.now() }],
    ]),
    // Disable cost-overshoot-based decomposition for tbench sessions.
    // The heuristic forecast (token-count-based) is not calibrated against
    // the USD values in MockProvider scripts, producing spurious 100x+ overshots.
    // Real billing decomposition decisions should use runProbesAsync() results
    // and a cost-meter backed by real provider pricing.
    disableCostOvershootDecompose: true,
  });
  surveillance.runProbes(provider);

  // KernelDeps — pass the session-scoped registry and surveillance.
  const kernelDeps: KernelDeps = {
    toolRegistry: sessionToolRegistry,
    surveillance,
    // ADR 0035: requireVerdictBeforeExit = true enforces that the Adjudicator
    // actually issued a verdict before endSession() completes. This is cheap:
    // the acceptance command already runs before endSession() is called.
    verification: {
      mode: "off",
      requireVerdictBeforeExit: true,
    },
    // Optional recorder: enables session recording for replay demos.
    // The kernel auto-starts the recorder on setSession() when provided.
    ...(opts.recorder !== undefined ? { recorder: opts.recorder } : {}),
    // Optional replay: when replayRecord + replayProviderFactory are provided,
    // the kernel routes all provider.invoke() calls through the RecordedProvider.
    ...(opts.replayRecord !== undefined ? { replayRecord: opts.replayRecord } : {}),
    ...(opts.replayProviderFactory !== undefined
      ? { replayProviderFactory: opts.replayProviderFactory }
      : {}),
  };

  // Use reproducibility:"record-replay" when replay options are provided.
  const reproducibility =
    opts.replayRecord !== undefined && opts.replayProviderFactory !== undefined
      ? ("record-replay" as const)
      : ("free" as const);

  // Kernel
  const kernel = new Kernel(
    {
      mode: "auto",
      reproducibility,
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 512 },
      roles: {
        adjudicator: adjudicatorId,
      },
      trustMode: "explicit",
    },
    kernelDeps,
  );

  kernel.mountProvider(provider);
  // Mount the passthrough InProcSandbox on the kernel — NOT the tool-level sandbox.
  // See Bug 2 fix comment in the sandbox construction block above.
  kernel.mountSandbox(kernelSandbox);
  kernel.mountSurveillance(surveillance);
  // Mount the schema adapter if provided. Real providers (OpenAI, Anthropic) need
  // this to translate tool specs into the shape their API expects (e.g. OpenAI
  // requires sanitized function names, Anthropic has different required/properties
  // ordering). MockProvider doesn't care — adapter may be omitted for tests.
  if (opts.schemaAdapter !== undefined) {
    kernel.mountSchemaAdapter(provider.capabilities.id, opts.schemaAdapter);
  }

  kernel.setSession(sessionId, contractId);

  // Spawn the adjudicator agent spec on the kernel (registers it for verdict tracking)
  // We fire-and-forget: adjudicator agents don't run loops, they respond to bus events.
  void kernel.spawn(adjSpec);

  // Start adjudicator bus watching
  const stopAdjudicatorWatch = watchBus({ bus: kernel.getBus(), sessionId });

  return {
    kernel,
    sessionId,
    agentId,
    adjudicatorId,
    stopAdjudicatorWatch,
    getLastVerdict: () => lastVerdict,
  };
}
