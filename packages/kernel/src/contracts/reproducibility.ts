/**
 * Reproducibility tier — honest claims only.
 *
 * The harness explicitly does NOT promise that two fresh runs of the same
 * session produce identical model outputs. Across providers, inference
 * servers, and versions, "same seed → same output" is unenforceable.
 *
 *   record-replay : replay reads from a SessionRecord; the model is never
 *                   re-prompted. FULLY REPRODUCIBLE regardless of model
 *                   variance.
 *   pinned        : pin seed / temperature / top-p where the provider
 *                   supports it; record observed divergence on replay.
 *                   Best-effort.
 *   free          : no pinning.
 */

import type { ProviderId } from "./provider.js";

export type ReproducibilityTier = "record-replay" | "pinned" | "free";

/**
 * Recorded divergence between an expected (pinned) call and the actual call.
 * Surfaced on replay or comparison runs.
 */
export interface Divergence {
  readonly at: number;
  readonly providerId: ProviderId;
  readonly tier: ReproducibilityTier;
  readonly category: "text" | "tool_call" | "stop_reason" | "usage";
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly note?: string;
}
