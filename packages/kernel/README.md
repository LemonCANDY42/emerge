# @emerge/kernel

Contracts, scheduler, message bus, and lifecycle runtime for the emerge agent harness.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install @emerge/kernel
```

## Quick example

```ts
import { Kernel } from "@emerge/kernel";
import type { AgentSpec } from "@emerge/kernel";

const kernel = new Kernel({ telemetry: myTelemetry });
await kernel.startSession();

const spec: AgentSpec = {
  id: "agent-1",
  provider: myProvider,
  systemPrompt: "You are a helpful assistant.",
  tools: [],
};

const handle = (await kernel.spawn(spec)).value;
await kernel.runAgent(handle);
await kernel.endSession();
```

## Subpath exports

- `@emerge/kernel` — full public surface (re-exports contracts + runtime)
- `@emerge/kernel/contracts` — type contracts only (zero runtime deps)
- `@emerge/kernel/runtime` — runtime implementations

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
