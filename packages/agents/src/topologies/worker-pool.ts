/**
 * workerPool topology builder.
 *
 * Stateless workers claim tasks from a shared in-memory queue (lease-based).
 * Returns a run() helper that:
 *   1. Distributes tasks across available workers.
 *   2. Workers publish progress envelopes to a shared topic; demo can subscribe.
 *   3. Collects results (default: array).
 */

import type {
  AgentHandle,
  AgentId,
  AgentSpec,
  Bus,
  ContractError,
  CorrelationId,
  Result,
  SessionId,
  Topology,
  TopologyEdge,
  TopologyMember,
} from "@emerge/kernel/contracts";
import type { SubTask } from "./supervisor-worker.js";
import type { KernelLike } from "./supervisor-worker.js";

export interface WorkerPoolConfig {
  readonly pool: readonly AgentSpec[];
  readonly queue: readonly SubTask[];
  /** Optional result reducer; default collects into an array. */
  readonly reducer?: (results: readonly unknown[]) => unknown;
}

export interface WorkerPoolHandle {
  readonly topology: Topology;
  run(kernel: KernelLike, sessionId: SessionId): Promise<Result<unknown>>;
}

export type WorkerPoolResult = Result<WorkerPoolHandle, ContractError>;

function warnIfMissingTermination(spec: AgentSpec): void {
  if (!spec.termination) {
    throw new Error(`workerPool: worker (id=${spec.id}) is missing a TerminationPolicy`);
  }
}

/** In-memory lease queue: claims next unclaimed task. */
class LeaseQueue {
  private readonly tasks: SubTask[];
  private claimed = 0;

  constructor(tasks: readonly SubTask[]) {
    this.tasks = [...tasks];
  }

  claim(): SubTask | undefined {
    if (this.claimed >= this.tasks.length) return undefined;
    return this.tasks[this.claimed++];
  }

  get remaining(): number {
    return this.tasks.length - this.claimed;
  }
}

/**
 * C6: Returns Result instead of throwing on bad input.
 */
export function workerPool(config: WorkerPoolConfig): WorkerPoolResult {
  const { pool, queue, reducer = (r) => r } = config;

  for (const w of pool) {
    if (!w.termination) {
      return {
        ok: false,
        error: {
          code: "E_INVALID_TOPOLOGY",
          message: `workerPool: worker (id=${w.id}) is missing a TerminationPolicy`,
        },
      };
    }
    warnIfMissingTermination(w);
  }

  const members: readonly TopologyMember[] = pool.map((w) => ({
    agent: w.id,
    role: "worker",
  }));

  const edges: readonly TopologyEdge[] = [];

  const topology: Topology = {
    spec: { kind: "worker-pool", config: { poolSize: pool.length, queueLength: queue.length } },
    members,
    edges,
  };

  async function run(kernel: KernelLike, sessionId: SessionId): Promise<Result<unknown>> {
    const lease = new LeaseQueue(queue);
    const bus = kernel.getBus();

    // Spawn all workers
    const handles: AgentHandle[] = [];
    for (const spec of pool) {
      const sp = await kernel.spawn(spec);
      if (!sp.ok) return sp;
      handles.push(sp.value);
    }

    const poolCorrId = `pool-${Date.now()}` as CorrelationId;
    const allResults: unknown[] = [];

    // Distribute queue across workers round-robin
    const workerTasks = new Map<AgentId, SubTask[]>();
    for (const handle of handles) {
      workerTasks.set(handle.id, []);
    }

    let workerIndex = 0;
    let task = lease.claim();
    while (task !== undefined) {
      const handle = handles[workerIndex % handles.length];
      if (handle) {
        const existing = workerTasks.get(handle.id) ?? [];
        existing.push(task);
        workerTasks.set(handle.id, existing);
      }
      workerIndex++;
      task = lease.claim();
    }

    // Run all workers in parallel, collecting their results
    const runWorker = async (handle: AgentHandle): Promise<unknown[]> => {
      const tasks = workerTasks.get(handle.id) ?? [];
      const results: unknown[] = [];

      for (const t of tasks) {
        const corrId = `pool-task-${t.id}-${Date.now()}` as CorrelationId;

        await bus.send({
          kind: "progress",
          correlationId: poolCorrId,
          sessionId,
          from: handle.id,
          to: { kind: "broadcast" },
          timestamp: Date.now(),
          note: `claiming task ${t.id}`,
        });

        // Subscribe to own result before running
        const sub = bus.subscribe(handle.id, { kind: "self" });

        await bus.send({
          kind: "request",
          correlationId: corrId,
          sessionId,
          from: handle.id,
          to: { kind: "agent", id: handle.id },
          timestamp: Date.now(),
          payload: t.payload,
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

        await bus.send({
          kind: "progress",
          correlationId: poolCorrId,
          sessionId,
          from: handle.id,
          to: { kind: "broadcast" },
          timestamp: Date.now(),
          note: `task ${t.id} complete`,
        });

        const r = await resultPromise;
        results.push(r);
      }

      return results;
    };

    const allWorkerResults = await Promise.all(handles.map(runWorker));
    for (const wr of allWorkerResults) {
      allResults.push(...wr);
    }

    return { ok: true, value: reducer(allResults) };
  }

  return { ok: true, value: { topology, run } };
}
