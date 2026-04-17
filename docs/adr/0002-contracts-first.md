# ADR 0002 — Contracts-first development

**Status:** accepted
**Date:** 2026-04-17

## Context

`emerge`'s thesis is that the harness should be a small kernel with stable,
narrow contracts; everything interesting lives in modules behind those
contracts. If the contracts wobble, every implementation wobbles with them.

## Decision

- The first commit publishes contracts before *any* implementation.
- All cross-package coupling goes through `@emerge/kernel/contracts`.
- Contract changes require an ADR or an issue with a design discussion;
  no contract changes via casual PRs.
- Contracts use **branded primitive types** (e.g. `AgentId`, `TaskId`) to
  prevent accidental cross-domain mixing.
- Contracts return `Result<T, ContractError>` for predictable failures;
  unrecoverable runtime errors throw.
- Contracts are **vendor-neutral**. Provider-specific shapes (Anthropic
  content blocks, OpenAI tool format) live inside provider packages and are
  translated at the boundary.

## Alternatives considered

- **Interfaces emerge from implementations.** Rejected: this is how harnesses
  end up tightly coupled to one model. We would not catch the coupling until
  swapping the provider.
- **Zod schemas as the contract source.** Deferred. Schemas are useful at
  package boundaries (provider input validation, tool inputs), but TypeScript
  types are the primary contract. Adding Zod to the kernel itself is a
  dependency and a runtime cost we don't yet justify.

## Consequences

- The first runnable demo is further away than it would be with an
  implementation-first approach.
- The harness's stability story is honest from day one: contracts versioned
  carefully, internals not promised.
- Contributors reading the kernel see the *shape* of the system before any
  vendor or storage detail clouds it.
