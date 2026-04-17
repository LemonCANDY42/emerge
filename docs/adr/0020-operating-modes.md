# ADR 0020 — Operating modes are composable policy triples

**Status:** accepted
**Date:** 2026-04-17

## Context

Claude Code's modes (auto / plan / bypass / accept-edit) are a UX-level
abstraction; under the hood they are a tangle of permission flags and
behavior toggles. We want modes that are first-class, composable, and
extensible — including user-defined.

## Decision

- `Mode = (PermissionPolicy, ToolSurface, BehaviorConfig)`.
- Built-in modes: `auto`, `plan`, `bypass`, `accept-edit`, `research`,
  `read`.
- Custom modes are pluggable via `ModeRegistry.define()`.
- `KernelConfig.mode` selects the active mode for a session.

## Alternatives considered

- **Modes as enums with hard-coded behavior.** Rejected: not extensible.
- **Modes as feature flags.** Rejected: orthogonal flag combinations
  multiply faster than they constrain.

## Consequences

- The CLI exposes a `--mode` flag and `/mode` slash command (M1).
- Documentation must keep up with what each built-in mode actually
  grants.
