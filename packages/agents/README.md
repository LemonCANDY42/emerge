# @lwrf42/emerge-agents

Topology helpers and agent roles for the emerge harness: supervisor, worker, pool, pipeline, and adjudicator.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install @lwrf42/emerge-agents
```

## Quick example

```ts
import { supervisorWorker } from "@lwrf42/emerge-agents";

// Build a supervisor-worker topology where the supervisor
// decomposes a task and workers execute sub-tasks.
const { run } = supervisorWorker({
  kernel,
  supervisorSpec,
  workerSpecs: [workerA, workerB],
});

await run();
```

## Exported roles

- `supervisorWorker` — supervisor decomposes, workers execute, results aggregated
- `Adjudicator` — evaluates acceptance criteria against verdicts
- `Custodian` — holds the master work contract with pinned-context discipline

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
