# CLAUDE.md — emerge

Instructions for Claude Code (and other agents) working in this repo.

## If you are an AI agent

Start with [AGENTS.md](./AGENTS.md), not this file. AGENTS.md is the entry point for any AI agent landing in this repo. CLAUDE.md is for human developers using Claude Code.

## What this project is

`emerge` is a TypeScript agent harness. Read [VISION.md](./VISION.md) and
[ARCHITECTURE.md](./ARCHITECTURE.md) before making non-trivial changes —
they are the contract you are building toward, not historical notes.

## Hard rules

- **Contracts in `packages/kernel/src/contracts/` are load-bearing.** A
  contract change ripples to every implementation. Treat changes as design
  proposals: open an issue or write a short ADR in `docs/adr/` first.
- **No vendor lock-in inside the kernel.** Anything specific to one model
  provider lives in `packages/providers/<vendor>`. The kernel must compile
  with zero provider dependencies.
- **Token cost is a design constraint.** When adding to a hot path, justify
  the token impact in the PR description.
- **Don't bypass surveillance.** Adaptive decomposition is the project's
  thesis. Code that hard-assumes a strong model defeats the whole point.

## Working style for this repo

- Prefer editing existing files over adding new ones.
- Don't create speculative packages, files, or abstractions. Add them when
  the second concrete use-case appears.
- Don't write what the code already says. Reserve comments for non-obvious
  *why*.
- Tests for public behavior, not for implementation details.

## Commit conventions

Conventional Commits:
`feat(kernel): ...` · `fix(memory): ...` · `docs: ...` · `chore: ...` ·
`refactor: ...` · `test: ...`

Scope = the affected package, omit for repo-wide changes.

## Architecture decisions (ADRs)

Significant design choices land in `docs/adr/NNNN-title.md`. One file per
decision. State the problem, the alternatives considered, the choice, and
the consequences.
