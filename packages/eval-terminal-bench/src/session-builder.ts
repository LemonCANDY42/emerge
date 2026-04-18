/**
 * session-builder — constructs a Kernel wired for Terminal-Bench task execution.
 *
 * Wires: provider + tools (fs.read, fs.write, bash) + adjudicator +
 * workspace-scoped sandbox. The caller is responsible for spawning the
 * agent spec and calling endSession().
 */

import { buildAdjudicator } from "@emerge/agents";
import type {
  AgentId,
  ContractId,
  EvaluationInput,
  Provider,
  SessionId,
  Tool,
  Verdict,
} from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { HarborSandbox } from "@emerge/sandbox-harbor";
import { InProcSandbox } from "@emerge/sandbox-inproc";
import { makeBashTool, makeFsReadTool, makeFsWriteTool } from "@emerge/tools";
import { makeAcceptanceEvaluator } from "./acceptance-runner.js";
import type { TaskSpec } from "./task-loader.js";

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
}

// ─── Built session handle ────────────────────────────────────────────────────

export interface BuiltSession {
  readonly kernel: Kernel;
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly adjudicatorId: AgentId;
  /** Call before endSession() to tear down adjudicator bus subscriptions. */
  stopAdjudicatorWatch(): void;
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

  const inprocPolicy: import("@emerge/kernel/contracts").PermissionPolicy = {
    fs: { read: "auto", write: "auto", delete: "deny" },
    net: { read: "deny", write: "deny" },
    process: { spawn: "auto", kill: "deny" },
    agent: { spawn: "deny", message: "deny" },
    tools: { allow: "all" },
    mcp: { servers: "all" },
  };

  const sandbox =
    sandboxMode === "harbor" ? new HarborSandbox(harborOpts) : new InProcSandbox(inprocPolicy);

  // Acceptance evaluator (command-based; ignores LLM output)
  const baseEvaluator = makeAcceptanceEvaluator(
    spec.acceptanceCommand,
    workspaceRoot,
    spec.timeoutSeconds,
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

  // Kernel
  // Use "free" reproducibility by default: the session is not pinned to
  // deterministic outputs. Set to "record-replay" in the blueprint options
  // when you want full reproducibility (requires a replayRecord in KernelDeps).
  const kernel = new Kernel({
    mode: "auto",
    reproducibility: "free",
    lineage: { maxDepth: 4 },
    bus: { bufferSize: 512 },
    roles: {
      adjudicator: adjudicatorId,
    },
    trustMode: "explicit",
  });

  kernel.mountProvider(provider);

  // Register tools scoped to workspace root.
  // Wrap each tool with defaultMode:"auto" so the agent-runner does not emit
  // human.request for fs.write and bash (which ship with defaultMode:"ask").
  // The sandbox policy is the real authorization gate in eval context.
  const registry = kernel.getToolRegistry();
  registry.register(withAutoPermission(makeFsReadTool(sandbox)));
  registry.register(withAutoPermission(makeFsWriteTool(sandbox)));
  registry.register(withAutoPermission(makeBashTool(sandbox)));

  kernel.setSession(sessionId, contractId);

  // Spawn the adjudicator agent spec on the kernel (registers it for verdict tracking)
  // We fire-and-forget: adjudicator agents don't run loops, they respond to bus events.
  // Any spawn error is captured in the returned promise — callers may await it.
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
