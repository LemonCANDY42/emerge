# ADR 0015 — Artifact lifecycle

**Status:** accepted
**Date:** 2026-04-17

## Context

Large outputs in messages explode token cost and make replay logs huge.
The community pattern is: externalize the bytes; pass a handle.

We need a lifecycle so artifacts don't accumulate forever, and so
modules can route artifacts to different stores (in-process / local fs /
S3) behind a stable interface.

## Decision

- `Artifact` lifecycle: `draft → active → archived → expired`.
- The Custodian routes artifacts; the kernel exposes a thin
  `ArtifactStore` facade.
- `ArtifactHandle`s are first-class on the bus (`artifact.put` /
  `artifact.get`) and may be referenced from `MemoryItem.attributes`.
- Lifecycle policy (`archiveAfterMs`, `expireAfterMs`) is per-artifact.

## Alternatives considered

- **Inline payloads.** Rejected: token cost.
- **External store with no handle in the kernel.** Rejected: every
  module reinvents handle resolution.

## Consequences

- Implementations must distinguish "in flight" (`draft`) from "committed"
  (`active`) — useful for transactional writes.
- The default local-fs implementation is the M3 milestone.
