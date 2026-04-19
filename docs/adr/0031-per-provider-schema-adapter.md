# ADR 0031 — Per-provider JSON-schema adapter

**Status:** accepted
**Date:** 2026-04-17

## Context

Different model providers parse JSON Schema tool specs with different expectations:

- **Anthropic** — requires `required` before `properties` in some tool-use
  pipeline variants; does not support several `format` keywords (`date`,
  `time`, `uri`, `email`, `uuid`); misinterprets single-entry `oneOf`/`anyOf`
  wrappers emitted by code-generation libraries such as `zod-to-json-schema`.
- **OpenAI** — prefers `properties` before `required`; does not honor
  `additionalProperties: false` reliably and may silently reject the call.
- **Future providers** (Gemini, Mistral, local models) — will have their own
  quirks.

Patching tool definitions per-provider inside each `ToolSpec` would scatter
provider awareness throughout the codebase and violate the contracts-first
principle (ADR 0002). Tool authors should not have to know about provider
quirks.

## Decision

Introduce a `SchemaAdapter` interface in
`packages/kernel/src/runtime/schema-adapter.ts`:

```ts
interface SchemaAdapter {
  readonly name: string;
  adapt(spec: ToolSpec, providerId: ProviderId): unknown;
}
```

Ship three built-in adapters:

| Adapter | Transformations |
|---|---|
| `defaultAdapter` | identity — returns `spec.jsonSchema` unchanged |
| `anthropicAdapter` | hoist `required` before `properties`; flatten single-entry `oneOf`/`anyOf`; strip unsupported `format` keywords |
| `openaiAdapter` | hoist `properties` before `required`; strip `additionalProperties: false`; flatten single-entry `oneOf`/`anyOf` |

A `SchemaAdapterRegistry` keyed by provider id is mounted inside `Kernel`
via `kernel.mountSchemaAdapter(providerId, adapter)`. The agent runner reads
from the registry when serializing provider tool-call specs, falling back to
`defaultAdapter` when no match is found.

The canonical `ToolSpec.jsonSchema` is never mutated; adapters work on a
derived object created at call time.

## Alternatives considered

- **Provider-specific tool registry** — Each provider holds its own adapted
  copy. Rejected: duplicates all tool metadata; hard to keep in sync.
- **Transform at ToolSpec registration time** — Adapters run when tools are
  mounted. Rejected: same tool may be used by multiple providers in a
  multi-provider session; premature transformation forfeits that flexibility.
- **Provider SDK normalization** — Push the cleanup into each provider package.
  Rejected: couples provider packages to the tool system; this layer already
  exists as the right seam.

## Consequences

- Tool authors write one canonical schema; providers receive a tailored view.
- Adapters are unit-testable in isolation without a live provider.
- New providers require only a new adapter mounted at startup — no changes to
  tool definitions.
- `SchemaAdapterRegistry`, `defaultAdapter`, `anthropicAdapter`, and
  `openaiAdapter` are exported from `@lwrf42/emerge-kernel/runtime` for use by
  provider packages.
