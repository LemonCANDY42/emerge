# @lwrf42/emerge-sandbox-inproc

In-process sandbox with permission policy enforcement for the emerge agent harness.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install @lwrf42/emerge-sandbox-inproc
```

## Quick example

```ts
import { InProcSandbox } from "@lwrf42/emerge-sandbox-inproc";

const sandbox = new InProcSandbox({
  workspaceRoot: "/tmp/my-task",
  policy: { defaultMode: "auto" },  // auto-approve all tool calls
});

// Pass sandbox to a Kernel or blueprint as the execution environment.
const kernel = new Kernel({ sandbox, provider, telemetry });
```

## When to use

- Fast local development and CI: no Docker required
- Unit/integration tests: deterministic, same process
- Eval runs where speed matters more than container isolation

For strong isolation, use `@lwrf42/emerge-sandbox-harbor` (Docker).

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
