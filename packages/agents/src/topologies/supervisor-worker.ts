/**
 * supervisorWorker topology builder.
 *
 * Creates a Topology value and a `run(input)` helper that:
 *   1. Splits the input into sub-tasks (one per worker) via a decomposer.
 *   2. Dispatches workers (sequential or parallel) against the bus.
 *   3. Aggregates worker results into a single output via a reducer.
 *
 * The supervisor subscribes to each worker's broadcasts (delta + progress +
 * result) and surfaces them upward via its own progress envelopes.
 *
 * ACL constraint check: emits console.warn for over-permissive workers.
 * Strict refusal ships in M4.
 */

import type {
  AgentHandle,
  AgentId,
  AgentSpec,
  Bus,
  CorrelationId,
  Result,
  SessionId,
  Topology,
  TopologyEdge,
  TopologyMember,
} from "@emerge/kernel/contracts";

export interface SubTask {
  readonly id: string;
  readonly payload: unknown;
}

export interface SupervisorWorkerConfig {
  readonly supervisor: AgentSpec;
  readonly workers: readonly AgentSpec[];
  readonly dispatch: "sequential" | "parallel";
  /** Optional decomposer; default splits a string goal into N chunks. */
  readonly decomposer?: (input: unknown) => SubTask[];
  /** Optional result reducer; default collects into an array. */
  readonly reducer?: (results: readonly unknown[]) => unknown;
}

/** Minimal interface for the Kernel operations we need. */
export interface KernelLike {
  spawn(spec: AgentSpec): Promise<Result<AgentHandle>>;
  runAgent(handle: AgentHandle): Promise<void>;
  getBus(): Bus;
}

export interface SupervisorWorkerHandle {
  readonly topology: Topology;
  run(input: unknown, kernel: KernelLike, sessionId: SessionId): Promise<Result<unknown>>;
}

function defaultDecomposer(workerCount: number, input: unknown): SubTask[] {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  if (workerCount === 0) return [];
  const chunkSize = Math.ceil(text.length / workerCount);
  return Array.from({ length: workerCount }, (_, i) => ({
    id: `subtask-${i}`,
    payload: text.slice(i * chunkSize, (i + 1) * chunkSize),
  }));
}

function defaultReducer(results: readonly unknown[]): unknown {
  return results;
}

function warnIfOverPermissive(spec: AgentSpec, label: string): void {
  if (spec.acl.acceptsRequests === "any") {
    console.warn(
      `[emerge/agents] ${label} (id=${spec.id}) has acl.acceptsRequests="any". Workers in a supervisor-worker topology should restrict to supervisor + kernel roles. Strict enforcement ships in M4.`,
    );
  }
}

/**
 * Subscribe to all workers' broadcasts from the supervisor's perspective,
 * forwarding delta + progress envelopes upward as supervisor progress envelopes.
 */
function watchWorkerBroadcasts(
  bus: Bus,
  supervisorId: AgentId,
  workerId: AgentId,
  sessionId: SessionId,
  corrId: CorrelationId,
): () => void {
  const sub = bus.subscribe(supervisorId, {
    kind: "from",
    sender: workerId,
    kinds: ["delta", "progress"],
  });
  let active = true;

  void (async () => {
    for await (const env of sub.events) {
      if (!active) break;
      // Re-emit upward as supervisor progress
      await bus.send({
        kind: "progress",
        correlationId: corrId,
        sessionId,
        from: supervisorId,
        to: { kind: "broadcast" },
        timestamp: Date.now(),
        note: `worker:${workerId} ${env.kind}`,
      });
    }
  })();

  return () => {
    active = false;
    sub.close();
  };
}

export function supervisorWorker(config: SupervisorWorkerConfig): SupervisorWorkerHandle {
  const { supervisor, workers, dispatch, reducer = defaultReducer } = config;
  const decomposer = config.decomposer;

  if (!supervisor.termination) {
    throw new Error(
      `supervisorWorker: supervisor (id=${supervisor.id}) is missing a TerminationPolicy`,
    );
  }
  for (const w of workers) {
    if (!w.termination) {
      throw new Error(`supervisorWorker: worker (id=${w.id}) is missing a TerminationPolicy`);
    }
    warnIfOverPermissive(w, "worker");
  }
  warnIfOverPermissive(supervisor, "supervisor");

  const members: readonly TopologyMember[] = [
    { agent: supervisor.id, role: "supervisor" },
    ...workers.map((w) => ({ agent: w.id, role: "worker" }) satisfies TopologyMember),
  ];

  const edges: readonly TopologyEdge[] = workers.map(
    (w) =>
      ({
        from: supervisor.id,
        to: w.id,
        kind: "request",
      }) satisfies TopologyEdge,
  );

  const topology: Topology = {
    spec: { kind: "supervisor-worker", config: { dispatch } },
    members,
    edges,
  };

  async function run(
    input: unknown,
    kernel: KernelLike,
    sessionId: SessionId,
  ): Promise<Result<unknown>> {
    // Spawn supervisor
    const spawnSup = await kernel.spawn(supervisor);
    if (!spawnSup.ok) return spawnSup;
    const supHandle = spawnSup.value;

    // Spawn workers
    const workerHandles: AgentHandle[] = [];
    for (const workerSpec of workers) {
      const sp = await kernel.spawn(workerSpec);
      if (!sp.ok) return sp;
      workerHandles.push(sp.value);
    }

    const bus = kernel.getBus();
    const tasks =
      decomposer !== undefined ? decomposer(input) : defaultDecomposer(workers.length, input);

    const supervisorCorrId = `sv-top-${Date.now()}` as CorrelationId;

    // Parallel: run all workers concurrently and collect their result envelopes
    const runWorker = async (handle: AgentHandle, taskIndex: number): Promise<unknown> => {
      const task = tasks[taskIndex];
      if (!task) return null;

      const corrId =
        `sw-${Date.now()}-${taskIndex}-${Math.random().toString(36).slice(2)}` as CorrelationId;

      // Set up worker broadcast watching before running
      const stopWatching = watchWorkerBroadcasts(
        bus,
        supHandle.id,
        handle.id,
        sessionId,
        supervisorCorrId,
      );

      // Subscribe to the worker's result before spawning
      const resultSub = bus.subscribe(supHandle.id, {
        kind: "from",
        sender: handle.id,
        kinds: ["result"],
      });

      // Send the task payload to the worker
      await bus.send({
        kind: "request",
        correlationId: corrId,
        sessionId,
        from: supHandle.id,
        to: { kind: "agent", id: handle.id },
        timestamp: Date.now(),
        payload: task.payload,
      });

      // Collect result — must start BEFORE runAgent resolves so we don't miss envelopes
      const resultPromise = (async (): Promise<unknown> => {
        for await (const env of resultSub.events) {
          if (env.kind === "result") {
            resultSub.close();
            return env.payload;
          }
        }
        resultSub.close();
        return null;
      })();

      // Run the worker loop to completion
      await kernel.runAgent(handle);

      // At this point the worker has emitted its result envelope, so await it
      const payload = await resultPromise;

      stopWatching();
      return payload;
    };

    let workerResults: unknown[];

    if (dispatch === "sequential") {
      workerResults = [];
      for (let i = 0; i < workerHandles.length; i++) {
        const h = workerHandles[i];
        if (!h) continue;
        const result = await runWorker(h, i);
        workerResults.push(result);
      }
    } else {
      workerResults = await Promise.all(workerHandles.map((h, i) => runWorker(h, i)));
    }

    // Emit a final progress from supervisor signalling completion
    await bus.send({
      kind: "progress",
      correlationId: supervisorCorrId,
      sessionId,
      from: supHandle.id,
      to: { kind: "broadcast" },
      timestamp: Date.now(),
      percent: 100,
      note: "all workers complete; aggregating",
    });

    const aggregate = reducer(workerResults);
    return { ok: true, value: aggregate };
  }

  return { topology, run };
}
