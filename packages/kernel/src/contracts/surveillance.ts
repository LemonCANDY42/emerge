/**
 * Surveillance — the differentiator.
 *
 * Continuously assesses the active model's competence on the current task
 * and recommends adaptive responses (decompose, scaffold, escalate, defer)
 * when the gap is too wide.
 *
 * The kernel calls `assess()` before running a step (when the agent's
 * SurveillanceProfile is "active" or "strict") and `observe()` after each
 * step regardless of profile.
 */

import type { AgentId, Confidence } from "./common.js";
import type { ExperienceLibrary, ExperienceMatch } from "./experience.js";
import type { ProviderCapabilities, ProviderId } from "./provider.js";
import type { ToolName } from "./tool.js";

/**
 * A unit of work the model is being asked to do. Provided by the planner;
 * may be refined by surveillance over time.
 */
export interface StepProfile {
  /** Stable id within the parent task graph. */
  readonly stepId: string;
  /** Coarse difficulty class. The kernel does not enforce a definition. */
  readonly difficulty: "trivial" | "small" | "medium" | "large" | "research";
  /** What the step is supposed to produce. */
  readonly goal: string;
  /** Tools the agent will be allowed to use for this step. */
  readonly tools: readonly ToolName[];
  /** Estimated input tokens at call time. */
  readonly estimatedTokensIn?: number;
  /** Whether the goal requires multi-call planning to be visible. */
  readonly requiresPlanning?: boolean;
}

/**
 * What surveillance recommends for this step.
 */
export type Recommendation =
  | {
      kind: "proceed";
      confidence: Confidence;
      rationale: string;
    }
  | {
      kind: "decompose";
      /** Suggested smaller steps. The planner is free to refine. */
      subSteps: readonly StepProfile[];
      rationale: string;
    }
  | {
      kind: "scaffold";
      /** What scaffolding to inject (e.g. examples, preconditions). */
      additions: readonly ScaffoldAddition[];
      rationale: string;
    }
  | {
      kind: "escalate";
      /** Provider to delegate to; result returns *opaque* to the inner agent. */
      delegateTo: ProviderId;
      rationale: string;
    }
  | {
      kind: "defer";
      /** Block until a human checkpoint resolves. */
      checkpoint: string;
      rationale: string;
    };

export interface ScaffoldAddition {
  readonly kind: "example" | "precondition" | "tool_restriction" | "system_note";
  readonly content: string;
}

/**
 * Signals collected after a step runs. Surveillance updates its envelope
 * model from these. Stable, vendor-neutral signals only.
 */
export interface StepObservation {
  readonly stepId: string;
  readonly agent: AgentId;
  readonly success: boolean;
  /** Number of model retries the kernel had to perform. */
  readonly retries: number;
  /** Number of tool calls that returned errors. */
  readonly toolErrors: number;
  /** Whether the agent self-corrected (revised an earlier statement). */
  readonly selfCorrections: number;
  readonly wallMs: number;
  /** Cost-overshoot ratio: actual / forecasted USD. Drives decompose/escalate. */
  readonly costOvershoot?: number;
  /** Cycle-guard fingerprint repeats observed during this step. */
  readonly cycleHits?: number;
}

export interface Surveillance {
  /**
   * Recommend an action for the upcoming step.
   * MUST return synchronously-resolved within budget; expensive computation
   * happens in `observe()`.
   */
  assess(input: AssessmentInput): Promise<Recommendation>;

  /** Update the envelope model with what actually happened. */
  observe(obs: StepObservation): Promise<void>;

  /** Read-only view of the current envelope for a provider. */
  envelope(providerId: ProviderId): ProviderCapabilities["observed"];
}

export interface AssessmentInput {
  readonly agent: AgentId;
  readonly providerId: ProviderId;
  readonly capabilities: ProviderCapabilities;
  readonly step: StepProfile;
  /** Current depth in the decomposition stack — surveillance bounds recursion. */
  readonly decompositionDepth: number;
  /**
   * Optional experience-library hints for the same task type / approach.
   * Surveillance uses these as priors to raise/lower the difficulty estimate
   * — closes the self-improving loop. See ADR 0029.
   */
  readonly experienceHints?: readonly ExperienceMatch[];
}

/**
 * The kernel injects this when it has an experience library. Surveillance
 * implementations may consult it during `assess()`.
 */
export interface ExperienceAware {
  setLibrary(lib: ExperienceLibrary): void;
}
