/**
 * pipeline topology builder.
 *
 * Wires N stages sequentially: A → B → C.
 * Each stage's output becomes the next stage's input via the bus.
 * Returns a run(input) helper.
 */

import type {
  AgentHandle,
  AgentId,
  AgentSpec,
  ContractError,
  CorrelationId,
  Result,
  SessionId,
  Topology,
  TopologyEdge,
  TopologyMember,
} from "@emerge/kernel/contracts";
import type { KernelLike } from "./supervisor-worker.js";

export interface PipelineConfig {
  readonly stages: readonly AgentSpec[];
  /** Optional result reducer for the final stage; default is identity. */
  readonly finalTransform?: (output: unknown) => unknown;
  /**
   * Mn8: The agent id to use as `from` for the first stage request.
   * Defaults to the first stage's own id (self-send) if not provided.
   * Pass a real orchestrator/supervisor agent id to avoid phantom sender ids.
   */
  readonly orchestratorId?: AgentId;
}

export interface PipelineHandle {
  readonly topology: Topology;
  run(input: unknown, kernel: KernelLike, sessionId: SessionId): Promise<Result<unknown>>;
}

export type PipelineResult = Result<PipelineHandle, ContractError>;

/**
 * C6: Returns Result instead of throwing on bad input.
 */
export function pipeline(config: PipelineConfig): PipelineResult {
  const { stages, finalTransform = (x) => x } = config;

  if (stages.length === 0) {
    return {
      ok: false,
      error: {
        code: "E_INVALID_TOPOLOGY",
        message: "pipeline: stages array must not be empty",
      },
    };
  }

  for (const s of stages) {
    if (!s.termination) {
      return {
        ok: false,
        error: {
          code: "E_INVALID_TOPOLOGY",
          message: `pipeline: stage (id=${s.id}) is missing a TerminationPolicy`,
        },
      };
    }
  }

  const members: readonly TopologyMember[] = stages.map((s, i) => ({
    agent: s.id,
    role: i === 0 ? "source" : i === stages.length - 1 ? "sink" : `stage-${i}`,
  }));

  const edges: readonly TopologyEdge[] = stages.slice(0, -1).map(
    (s, i) =>
      ({
        from: s.id,
        // biome-ignore lint/style/noNonNullAssertion: slice(0, -1) guarantees stages[i+1] exists
        to: stages[i + 1]!.id,
        kind: "request",
      }) satisfies TopologyEdge,
  );

  const topology: Topology = {
    spec: { kind: "pipeline", config: { stageCount: stages.length } },
    members,
    edges,
  };

  async function run(
    input: unknown,
    kernel: KernelLike,
    sessionId: SessionId,
  ): Promise<Result<unknown>> {
    // Spawn all stages upfront
    const handles: AgentHandle[] = [];
    for (const spec of stages) {
      const sp = await kernel.spawn(spec);
      if (!sp.ok) return sp;
      handles.push(sp.value);
    }

    const bus = kernel.getBus();
    let current: unknown = input;

    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      if (!handle) continue;

      const nextHandle = handles[i + 1];
      const corrId = `pipe-${i}-${Date.now()}` as CorrelationId;

      // Mn8: use orchestratorId for first-stage `from`; otherwise use previous stage id.
      const fromId: AgentId =
        i === 0 ? (config.orchestratorId ?? handle.id) : (handles[i - 1]?.id ?? handle.id);

      // Send the current value to this stage
      await bus.send({
        kind: "request",
        correlationId: corrId,
        sessionId,
        from: fromId,
        to: { kind: "agent", id: handle.id },
        timestamp: Date.now(),
        payload: current,
      });

      // Subscribe to receive the result before running
      const sub = bus.subscribe(handle.id, {
        kind: "from",
        sender: handle.id,
        kinds: ["result"],
      });

      const resultPromise = (async (): Promise<unknown> => {
        for await (const env of sub.events) {
          if (env.kind === "result") {
            sub.close();
            return env.payload;
          }
        }
        sub.close();
        return null;
      })();

      await kernel.runAgent(handle);
      current = await resultPromise;

      // If there's a next stage, also send a notification so it can pick up
      if (nextHandle) {
        await bus.send({
          kind: "notification",
          correlationId: corrId,
          sessionId,
          from: handle.id,
          to: { kind: "agent", id: nextHandle.id },
          timestamp: Date.now(),
          topic: "pipeline.stage.complete" as never,
          payload: current,
        });
      }
    }

    return { ok: true, value: finalTransform(current) };
  }

  return { ok: true, value: { topology, run } };
}
