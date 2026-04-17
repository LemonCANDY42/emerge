# ADR 0001 — TypeScript monorepo with pnpm workspaces

**Status:** accepted
**Date:** 2026-04-17

## Context

`emerge` is a kernel + many implementations. The kernel defines small, stable
contracts; provider/memory/tool/sandbox/surveillance/telemetry packages
implement them. We need:

- A single source of truth for shared contracts and types.
- Cheap cross-package refactors during the founding phase.
- A path to publishing each package independently to npm.
- A first-class agent ecosystem (MCP, Anthropic SDK, OpenAI SDK).

## Decision

- **TypeScript** with strict mode, NodeNext module resolution, and project
  references.
- **pnpm workspaces** (not yarn, not npm workspaces, not turborepo yet).
  pnpm gives us strict, fast, deterministic installs and clean
  per-package `node_modules`.
- **Biome** for format + lint as a single tool. We avoid the
  ESLint+Prettier dual-config tax.
- **tsc** for builds via project references; no bundler at the kernel level.
- **vitest** when tests land.

## Alternatives considered

- **Bun (single runtime + bundler).** Rejected for now: maturity in CI, broad
  contributor familiarity, and Node-native deployment targets matter more
  than Bun's perf for a pre-1.0 kernel. We can revisit.
- **Rust workspace.** Rejected: smaller agent ecosystem, slower iteration in
  the founding phase. The right call if `emerge` later spawns a perf-critical
  daemon.
- **Single-package layout.** Rejected: vendor-specific code (providers, MCP)
  must be tree-shakable per consumer; multi-package is the right shape.
- **turborepo / nx.** Deferred: overkill for current scale. Add if/when
  parallel build orchestration becomes a bottleneck.

## Consequences

- Anyone with Node 20.11+ and pnpm can build.
- We pay a small "two configs per package" tax (`package.json` + `tsconfig.json`).
- Project references mean `tsc -b` is incremental; no separate build tool needed.
- Publishing strategy: each `@emerge/*` package independently versioned,
  scoped public.
