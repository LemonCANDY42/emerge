/**
 * TerminationPolicy — mandatory at every spawn.
 *
 * The kernel refuses to spawn an agent whose spec lacks a complete
 * `TerminationPolicy`. This is the central defense against denial-of-wallet
 * loops, mutual respawn, and never-ending sessions.
 */

import type { Budget } from "./common.js";
import type { ToolName } from "./tool.js";

export interface TerminationPolicy {
  readonly maxIterations: number;
  readonly maxWallMs: number;
  readonly budget: Budget;
  readonly retry: RetryBudget;
  readonly cycle: CycleGuardConfig;
  readonly done: TerminationPredicate;
}

/**
 * Retry budget threaded through provider → tool → agent layers.
 * Non-retryable errors (auth, schema, policy) are budget-0 and abort.
 */
export interface RetryBudget {
  readonly transient: number;
  readonly nonRetryable: 0;
}

export interface CycleGuardConfig {
  /** Sliding window of recent calls fingerprinted. */
  readonly windowSize: number;
  /** Number of repeats within the window that triggers an interrupt. */
  readonly repeatThreshold: number;
}

export type TerminationPredicate =
  | { readonly kind: "tool_emitted"; readonly tool: ToolName }
  | { readonly kind: "state_match"; readonly key: string; readonly value: string }
  | {
      readonly kind: "regex";
      readonly field: "lastMessage" | "lastToolResult";
      readonly pattern: string;
    }
  /** Function predicates are not replay-safe; use sparingly. */
  | { readonly kind: "predicate"; readonly description: string };
