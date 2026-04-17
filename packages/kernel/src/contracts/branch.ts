/**
 * Speculative branch-and-merge.
 *
 * Contracts at M0; impl at M3 alongside topology helpers. Lets the kernel
 * run N decomposition branches in parallel, judge a winner, and harvest the
 * losers' lessons into the experience library.
 */

import type { Verdict } from "./adjudicator.js";
import type { BranchId, WorkspaceId } from "./common.js";
import type { TopologySpec } from "./topology.js";

export type BranchStatus = "running" | "won" | "lost" | "tied";

export interface Branch {
  readonly id: BranchId;
  readonly spec: TopologySpec;
  readonly workspace: WorkspaceId;
  readonly hypothesis: string;
  readonly status: BranchStatus;
}

export interface JudgeResult {
  readonly winners: readonly BranchId[];
  readonly verdicts: Readonly<Record<BranchId, Verdict>>;
  readonly rationale: string;
}

export interface BranchMerger {
  spawn(branches: readonly Omit<Branch, "status">[]): Promise<readonly Branch[]>;
  judge(branches: readonly Branch[]): Promise<JudgeResult>;
  collectLessons(losing: readonly Branch[]): Promise<readonly LessonRef[]>;
}

/** A reference to a lesson that will be ingested by the experience library. */
export interface LessonRef {
  readonly branch: BranchId;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}
