# @lwrf42/emerge-workspaces-git-worktree

Git worktree and scoped temporary directory workspace managers for the emerge agent harness.

Provides isolated `Workspace` implementations so parallel agents or speculative branches do not trample each other's files. Merges are explicit.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install @lwrf42/emerge-workspaces-git-worktree
```

## Quick example

```ts
import { GitWorktreeWorkspace, ScopedTmpWorkspace } from "@lwrf42/emerge-workspaces-git-worktree";

// Git worktree — each agent branch gets its own working tree.
const workspace = await GitWorktreeWorkspace.create({
  repoRoot: "/home/user/myproject",
  branchName: "agent/fix-bug-42",
});

// Scoped temp dir — ephemeral, cleaned up on dispose.
const tmpWs = await ScopedTmpWorkspace.create({ prefix: "emerge-agent-" });

// Use with eval-terminal-bench or directly with Kernel.
```

## Workspace isolation model

Each `Workspace` exposes a `root` path. The kernel and sandbox route all filesystem effects through this root. Parallel agents get parallel roots. Merging is explicit — the harness never auto-merges.

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
