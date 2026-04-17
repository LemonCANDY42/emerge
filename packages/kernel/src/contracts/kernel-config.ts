/**
 * KernelConfig — runtime knobs the kernel reads on session start.
 *
 * Designating Custodian / Adjudicator / Postmortem agents here is what makes
 * those *roles* kernel-aware: the kernel routes specific envelope kinds
 * (quota.*, verdict, postmortem trigger) to the designated id.
 */

import type { BusBackpressureConfig } from "./bus.js";
import type { AgentId } from "./common.js";
import type { LineageGuardConfig } from "./lineage.js";
import type { ModeName } from "./mode.js";
import type { ReproducibilityTier } from "./reproducibility.js";

export interface KernelConfig {
  readonly mode: ModeName;
  readonly reproducibility: ReproducibilityTier;
  readonly lineage: LineageGuardConfig;
  readonly bus: BusBackpressureConfig;
  readonly roles: {
    readonly custodian?: AgentId;
    readonly adjudicator?: AgentId;
    readonly postmortem?: AgentId;
  };
  /** When true, the kernel may auto-mark `completed` without an `aligned` verdict. */
  readonly trustMode?: "implicit" | "explicit";
}
