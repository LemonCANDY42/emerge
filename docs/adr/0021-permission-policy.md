# ADR 0021 — PermissionPolicy is session-level, distinct from per-tool descriptors

**Status:** accepted
**Date:** 2026-04-17

## Context

Two different "permission" concepts exist:
- What a tool *needs* (per-tool `PermissionDescriptor.effects`).
- What the active mode *grants* (session-level `PermissionPolicy`).

Conflating them produces ad-hoc enforcement (every tool re-implements
gating differently). The defense is a single, uniform check at the
kernel/sandbox boundary.

## Decision

- `PermissionPolicy` lives in the active `Mode` and is enforced by the
  kernel/sandbox at every tool call.
- A tool call is allowed iff `descriptor.effects ⊆ policy.allows` for
  every effect.
- `PermScope` per resource: `deny` / `ask` / `auto` / explicit allow-list.
- `ask` triggers a `human.request` envelope (ADR 0024).

## Alternatives considered

- **Per-tool gating.** Rejected: inconsistent enforcement; bypass-prone.
- **Mode flags only.** Rejected: too coarse; can't say "auto for fs.read,
  ask for fs.write".

## Consequences

- Tools cannot bypass the policy. Adding a tool with a new effect class
  requires the effect to exist in `ToolEffect` and be representable in
  `PermissionPolicy`.
- The CLI surfaces `ask` decisions through the approval queue.
