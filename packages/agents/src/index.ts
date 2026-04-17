/**
 * @emerge/agents — topology builders + role helpers.
 *
 * Exports:
 *   - supervisorWorker, workerPool, pipeline (topology helpers)
 *   - buildCustodian, buildAdjudicator, buildPostmortem (role helpers)
 *   - BlueprintRegistry, assembleAgent, genericWorkerBlueprint
 */

export { supervisorWorker } from "./topologies/supervisor-worker.js";
export type {
  SubTask,
  SupervisorWorkerConfig,
  SupervisorWorkerHandle,
  SupervisorWorkerResult,
  KernelLike,
} from "./topologies/supervisor-worker.js";

export { workerPool } from "./topologies/worker-pool.js";
export type {
  WorkerPoolConfig,
  WorkerPoolHandle,
  WorkerPoolResult,
} from "./topologies/worker-pool.js";

export { pipeline } from "./topologies/pipeline.js";
export type { PipelineConfig, PipelineHandle, PipelineResult } from "./topologies/pipeline.js";

export { buildCustodian } from "./roles/custodian.js";
export type { BuildCustodianOptions, CustodianBuild, QuotaPolicy } from "./roles/custodian.js";

export { buildAdjudicator } from "./roles/adjudicator.js";
export type { BuildAdjudicatorOptions, AdjudicatorBuild } from "./roles/adjudicator.js";

export { buildPostmortem, defaultAnalyze } from "./roles/postmortem.js";
export type { BuildPostmortemOptions, PostmortemBuild } from "./roles/postmortem.js";

export {
  BlueprintRegistry,
  assembleAgent,
  genericWorkerBlueprint,
} from "./blueprint-registry.js";
