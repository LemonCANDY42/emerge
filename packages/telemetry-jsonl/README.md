# @lwrf42/emerge-telemetry-jsonl

JSONL-backed telemetry writer for the emerge agent harness.

Appends structured event records to a `.jsonl` file — one JSON object per line, one line per event. Serves as the persistence layer for replay and TUI/dashboard streaming.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install @lwrf42/emerge-telemetry-jsonl
```

## Quick example

```ts
import { JsonlTelemetry } from "@lwrf42/emerge-telemetry-jsonl";

const telemetry = new JsonlTelemetry({ path: "/tmp/emerge/session.jsonl" });

const kernel = new Kernel({ telemetry, provider });
await kernel.startSession();
// ... all events written to session.jsonl as they occur ...
await kernel.endSession();
```

## Output format

Each line is a self-contained JSON envelope:

```json
{"t":"2026-04-18T12:00:00.000Z","kind":"agent:turn:start","agentId":"agent-1","payload":{...}}
{"t":"2026-04-18T12:00:01.200Z","kind":"llm:response","agentId":"agent-1","payload":{...}}
```

The JSONL file can be tailed live with `@lwrf42/emerge-tui` or loaded into `@lwrf42/emerge-dashboard`.

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
