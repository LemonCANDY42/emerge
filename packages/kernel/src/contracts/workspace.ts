/**
 * Workspace isolation (worktree-style).
 *
 * Each agent / topology branch / speculative branch can hold an addressable
 * `Workspace`; merges are explicit. Default impl = git worktree (when in a
 * git repo); fallback = scoped tmpdir. Critical so parallel agents don't
 * trample each other.
 */

import type { AgentId, Result, WorkspaceId } from "./common.js";

export type WorkspaceStatus = "active" | "merging" | "closed";

export interface Workspace {
  readonly id: WorkspaceId;
  readonly root: string;
  readonly baseRef?: string;
  readonly agent?: AgentId;
  readonly status: WorkspaceStatus;
}

export interface WorkspaceAllocation {
  readonly for: AgentId;
  readonly baseRef?: string;
  readonly hint?: string;
}

export interface MergeResult {
  readonly applied: boolean;
  readonly conflicts: readonly string[];
  readonly notes?: string;
}

export interface WorkspaceManager {
  allocate(spec: WorkspaceAllocation): Promise<Result<Workspace>>;
  close(id: WorkspaceId): Promise<Result<void>>;
  merge(from: WorkspaceId, into: WorkspaceId): Promise<Result<MergeResult>>;
  list(filter?: {
    readonly agent?: AgentId;
    readonly status?: WorkspaceStatus;
  }): readonly Workspace[];
}
