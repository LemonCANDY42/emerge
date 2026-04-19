# @emerge/provider-mock

Scripted mock LLM provider for deterministic testing and demos in the emerge harness.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install @emerge/provider-mock
```

## Quick example

```ts
import { MockProvider } from "@emerge/provider-mock";

const provider = new MockProvider([
  { role: "assistant", content: "Hello! How can I help?" },
  { role: "assistant", content: "Done." },
]);

// Use provider with Kernel — no real API calls made.
const kernel = new Kernel({ provider, telemetry });
```

## Use cases

- Unit tests: deterministic responses, zero network
- Demos: run without API keys
- Replay tests: scripted turn sequences

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
