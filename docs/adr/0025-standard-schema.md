# ADR 0025 — Standard Schema at every contract boundary

**Status:** accepted
**Date:** 2026-04-17

## Context

Contracts need typed boundaries — for tool inputs, agent IO, contract
outputs, bus payloads. Forcing a single validation library (Zod or
Valibot or ArkType) is a needless hard requirement; users have
preferences.

`standardschema.dev` v1 provides a vendor-neutral interface every modern
TS validator implements.

## Decision

- All contract boundaries that accept "schema" use `SchemaRef` — a thin
  alias for `StandardSchemaV1`.
- The kernel does not depend on any specific validator package.
- Tools may *also* publish a raw `jsonSchema` for clients that need it
  (e.g. provider tool-use payloads).

## Alternatives considered

- **Adopt Zod directly.** Rejected: Zod is excellent but is a hard dep
  many users want to swap.
- **Define our own schema interface.** Rejected: NIH; Standard Schema
  exists for exactly this reason.

## Consequences

- A `~standard.validate(value)` call is the universal validation entry
  point.
- The contracts compile with zero runtime dependencies.
