# @lwrf42/emerge-modes

Built-in operating modes and ModeRegistry for the emerge agent harness.

Provides `auto`, `plan`, `bypass`, `accept-edit`, `research`, and `read` modes with per-mode `PermissionPolicy` enforcement at the kernel/sandbox boundary.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install @lwrf42/emerge-modes
```

## Quick example

```ts
import { ModeRegistry, builtinModes } from "@lwrf42/emerge-modes";

const registry = new ModeRegistry();
for (const mode of builtinModes) {
  registry.register(mode);
}

// Get the permission policy for a given mode name.
const policy = registry.getPolicy("auto");
// policy.defaultMode === "auto" — all tool calls approved without prompting.

// Pass the registry to a Kernel.
const kernel = new Kernel({ modeRegistry: registry, provider, telemetry });
```

## Built-in modes

| Mode | Description |
|---|---|
| `auto` | All tool calls approved automatically |
| `plan` | Agent plans steps; execution requires approval |
| `bypass` | No permission checks (test/debug use only) |
| `accept-edit` | File edits auto-approved; others require approval |
| `research` | Read-only; no writes or shell execution |
| `read` | Read-only; most restrictive |

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
