/**
 * @lwrf42/emerge-agents — topology builders + role helpers.
 *
 * Exports:
 *   - supervisorWorker, workerPool, pipeline (topology helpers)
 *   - buildCustodian, buildAdjudicator, buildPostmortem (role helpers)
 *   - BlueprintRegistry, assembleAgent, genericWorkerBlueprint
 *   - acceptanceCriteriaFromContract (M4: helper to extract criterion text for supervisor prompt)
 */

export { supervisorWorker } from "./topologies/supervisor-worker.js";
export type {
  SubTask,
  SupervisorWorkerConfig,
  SupervisorWorkerHandle,
  SupervisorWorkerResult,
  KernelLike,
} from "./topologies/supervisor-worker.js";

/**
 * M4: Joins a Contract's acceptance criteria descriptions into a single string
 * suitable for inclusion in a supervisor aggregation prompt.
 *
 * Usage:
 *   supervisorWorker({
 *     ...
 *     acceptanceCriteria: acceptanceCriteriaFromContract(contract),
 *   })
 */
export function acceptanceCriteriaFromContract(
  contract: import("@lwrf42/emerge-kernel/contracts").Contract,
): string {
  return contract.acceptanceCriteria
    .filter(
      (c): c is { kind: "predicate" | "human-checkpoint"; description: string } =>
        "description" in c,
    )
    .map((c) => c.description)
    .join("; ");
}

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

export { makeVerifierAgent } from "./roles/verifier.js";
export type {
  MakeVerifierAgentOptions,
  VerifierAgentBuild,
  VerdictRequestPayload,
} from "./roles/verifier.js";

export {
  BlueprintRegistry,
  assembleAgent,
  genericWorkerBlueprint,
} from "./blueprint-registry.js";
