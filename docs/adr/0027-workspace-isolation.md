# ADR 0027 — Workspace isolation (worktree-style)

**Status:** accepted
**Date:** 2026-04-17

## Context

Parallel agents (worker-pool, swarm, speculative branches) that share
one filesystem trample each other: same paths, conflicting edits, races.
The `learn-claude-code` distillation calls out worktree isolation as
critical for parallel-agent setups.

## Decision

- `Workspace` is a kernel contract (id, root path, optional baseRef,
  optional owning agent, status).
- A `WorkspaceManager` allocates / closes / merges workspaces.
- Default implementation = git worktree (when running in a git repo);
  fallback = scoped tmpdir.
- Topology helpers that spawn parallel agents allocate workspaces by
  default.
- Merges on completion are explicit, not implicit.

## Alternatives considered

- **Shared workspace, locks.** Rejected: locks are a poor fit for an
  LLM that doesn't model lock semantics.
- **In-memory virtual fs.** Rejected: defeats integration with real
  tools (compilers, test runners).

## Consequences

- Speculative branches and swarms work without trampling.
- Git worktree usage requires the host repo to support worktrees;
  fallback handles non-git environments.
