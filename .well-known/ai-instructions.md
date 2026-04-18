# AI Instructions — emerge

This file helps AI agents discover how to work with this codebase.

**Repository:** emerge — TypeScript agent harness for building durable, model-aware AI agents.

**Entry points for AI agents:**
1. [AGENTS.md](../AGENTS.md) — Navigation guide, contracts overview, hard rules
2. [docs/agents/index.md](../docs/agents/index.md) — Agent type matrix and selection guide
3. [docs/usage.md](../docs/usage.md) — SDK integration guide
4. [ARCHITECTURE.md](../ARCHITECTURE.md) — Design principles and layer overview

**Key contracts:** `/Users/kennymccormick/github/emerge/packages/kernel/src/contracts/` (31 files; source of truth)

**Hard rules:**
- No contract edits without an issue or ADR
- No vendor lock-in in kernel; vendor code in providers/
- Token cost is a design constraint
- `pnpm typecheck`, `pnpm lint`, `pnpm test` must pass

**What you're looking at:** 26 packages, 150 source files, 115 tests, 33 ADRs, 10 demos.

**Repository URL:** https://github.com/LemonCANDY42/emerge

**License:** MIT

---

For more, see [AGENTS.md](../AGENTS.md).
