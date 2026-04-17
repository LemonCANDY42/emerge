/**
 * Workspace implementations backed by git worktrees (when in a git repo) or
 * a scoped tmpdir fallback (ScopedTmpdirWorkspaceManager).
 *
 * GitWorktreeWorkspaceManager:
 *   - Detects git via `git rev-parse --git-dir` (execFileSync, no shell).
 *   - In git mode: allocate → `git worktree add -b emerge/<id> <path> <baseRef>`.
 *   - In tmpdir fallback: behaves identically to ScopedTmpdirWorkspaceManager.
 *   - merge() is unsupported in tmpdir mode → Result.error E_NO_MERGE_SUPPORT.
 *   - list() returns from in-memory map (persistence is M4).
 *
 * ScopedTmpdirWorkspaceManager:
 *   - Creates isolated tmpdir per allocation; rm -rf on close.
 *   - merge() always returns E_NO_MERGE_SUPPORT.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentId,
  MergeResult,
  Result,
  Workspace,
  WorkspaceAllocation,
  WorkspaceId,
  WorkspaceManager,
  WorkspaceStatus,
} from "@emerge/kernel/contracts";

let _wsCounter = 0;
function newWorkspaceId(): WorkspaceId {
  return `ws-${Date.now()}-${++_wsCounter}` as WorkspaceId;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf-8" }).trim();
}

function isGitRepo(dir: string): boolean {
  try {
    git(dir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

export class ScopedTmpdirWorkspaceManager implements WorkspaceManager {
  private readonly baseDir: string;
  private readonly workspaces = new Map<WorkspaceId, Workspace>();

  constructor(opts: { baseDir?: string } = {}) {
    this.baseDir = opts.baseDir ?? path.join(os.tmpdir(), ".emerge-workspaces");
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  async allocate(spec: WorkspaceAllocation): Promise<Result<Workspace>> {
    const id = newWorkspaceId();
    const root = fs.mkdtempSync(path.join(this.baseDir, `${id}-`));
    const ws: Workspace = {
      id,
      root,
      ...(spec.baseRef !== undefined ? { baseRef: spec.baseRef } : {}),
      agent: spec.for,
      status: "active",
    };
    this.workspaces.set(id, ws);
    return { ok: true, value: ws };
  }

  async close(id: WorkspaceId): Promise<Result<void>> {
    const ws = this.workspaces.get(id);
    if (!ws) {
      return {
        ok: false,
        error: { code: "E_WORKSPACE_NOT_FOUND", message: `Workspace ${id} not found` },
      };
    }
    try {
      fs.rmSync(ws.root, { recursive: true, force: true });
    } catch {
      // tolerate already-deleted
    }
    const closed: Workspace = { ...ws, status: "closed" };
    this.workspaces.set(id, closed);
    return { ok: true, value: undefined };
  }

  async merge(_from: WorkspaceId, _into: WorkspaceId): Promise<Result<MergeResult>> {
    return {
      ok: false,
      error: {
        code: "E_NO_MERGE_SUPPORT",
        message:
          "ScopedTmpdirWorkspaceManager does not support merge; use GitWorktreeWorkspaceManager in a git repo.",
      },
    };
  }

  list(filter?: {
    readonly agent?: AgentId;
    readonly status?: WorkspaceStatus;
  }): readonly Workspace[] {
    let result = [...this.workspaces.values()];
    if (filter?.agent !== undefined) {
      result = result.filter((w) => w.agent === filter.agent);
    }
    if (filter?.status !== undefined) {
      result = result.filter((w) => w.status === filter.status);
    }
    return result;
  }
}

export class GitWorktreeWorkspaceManager implements WorkspaceManager {
  private readonly baseRepo: string;
  private readonly worktreesDir: string;
  private readonly gitMode: boolean;
  private readonly workspaces = new Map<WorkspaceId, Workspace>();
  /** Branch name used for each workspace id in git mode. */
  private readonly branches = new Map<WorkspaceId, string>();
  private readonly fallback: ScopedTmpdirWorkspaceManager;

  constructor(opts: { baseRepo: string; worktreesDir?: string }) {
    this.baseRepo = opts.baseRepo;
    this.worktreesDir = opts.worktreesDir ?? path.join(opts.baseRepo, ".emerge/worktrees");
    this.gitMode = isGitRepo(opts.baseRepo);
    this.fallback = new ScopedTmpdirWorkspaceManager({ baseDir: this.worktreesDir });
    if (this.gitMode) {
      fs.mkdirSync(this.worktreesDir, { recursive: true });
    }
  }

  async allocate(spec: WorkspaceAllocation): Promise<Result<Workspace>> {
    if (!this.gitMode) {
      const r = await this.fallback.allocate(spec);
      if (r.ok) this.workspaces.set(r.value.id, r.value);
      return r;
    }

    const id = newWorkspaceId();
    const branch = `emerge/${id}`;
    const worktreePath = path.join(this.worktreesDir, String(id));
    const baseRef = spec.baseRef ?? "HEAD";

    try {
      git(this.baseRepo, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "E_WORKTREE_ADD",
          message: `git worktree add failed: ${String(err)}`,
          cause: err,
        },
      };
    }

    const ws: Workspace = {
      id,
      root: worktreePath,
      baseRef,
      agent: spec.for,
      status: "active",
    };
    this.workspaces.set(id, ws);
    this.branches.set(id, branch);
    return { ok: true, value: ws };
  }

  async close(id: WorkspaceId): Promise<Result<void>> {
    if (!this.gitMode) {
      const r = await this.fallback.close(id);
      if (r.ok) {
        const existing = this.workspaces.get(id);
        if (existing) this.workspaces.set(id, { ...existing, status: "closed" });
      }
      return r;
    }

    const ws = this.workspaces.get(id);
    if (!ws) {
      return {
        ok: false,
        error: { code: "E_WORKSPACE_NOT_FOUND", message: `Workspace ${id} not found` },
      };
    }

    const branch = this.branches.get(id);
    try {
      git(this.baseRepo, ["worktree", "remove", "--force", ws.root]);
    } catch {
      // tolerate already-removed
    }
    if (branch) {
      try {
        git(this.baseRepo, ["branch", "-D", branch]);
      } catch {
        // tolerate already-deleted
      }
    }

    const closed: Workspace = { ...ws, status: "closed" };
    this.workspaces.set(id, closed);
    return { ok: true, value: undefined };
  }

  async merge(from: WorkspaceId, into: WorkspaceId): Promise<Result<MergeResult>> {
    if (!this.gitMode) {
      return {
        ok: false,
        error: { code: "E_NO_MERGE_SUPPORT", message: "Not in git mode." },
      };
    }

    const fromBranch = this.branches.get(from);
    const intoBranch = this.branches.get(into);

    if (!fromBranch || !intoBranch) {
      return {
        ok: false,
        error: {
          code: "E_WORKSPACE_NOT_FOUND",
          message: `Branch not found for from=${String(from)} or into=${String(into)}`,
        },
      };
    }

    const intoWs = this.workspaces.get(into);
    if (!intoWs) {
      return {
        ok: false,
        error: { code: "E_WORKSPACE_NOT_FOUND", message: `Workspace ${String(into)} not found` },
      };
    }

    try {
      git(intoWs.root, ["checkout", intoBranch]);
      git(intoWs.root, ["merge", "--no-edit", fromBranch]);
      return { ok: true, value: { applied: true, conflicts: [] } };
    } catch (err) {
      const conflicts: string[] = [];
      try {
        const conflictOutput = git(intoWs.root, ["diff", "--name-only", "--diff-filter=U"]);
        conflicts.push(...conflictOutput.split("\n").filter(Boolean));
      } catch {
        // swallow
      }
      return {
        ok: true,
        value: {
          applied: false,
          conflicts,
          notes: String(err),
        },
      };
    }
  }

  list(filter?: {
    readonly agent?: AgentId;
    readonly status?: WorkspaceStatus;
  }): readonly Workspace[] {
    let result = [...this.workspaces.values()];
    if (filter?.agent !== undefined) {
      result = result.filter((w) => w.agent === filter.agent);
    }
    if (filter?.status !== undefined) {
      result = result.filter((w) => w.status === filter.status);
    }
    return result;
  }
}

export type {
  WorkspaceManager,
  Workspace,
  WorkspaceAllocation,
  MergeResult,
  WorkspaceId,
  WorkspaceStatus,
  AgentId,
};
