# @emerge/replay

Session recorder and deterministic replayer for the emerge agent harness.

Records all LLM calls and tool results during a live session. Replays them from the log with zero real API calls, reproducing the exact same file side-effects.

v0.1.0 — early. Replay reproducibility verified end-to-end — see VERIFICATION.md.

## Install

```bash
npm install @emerge/replay
```

## Quick example — record

```ts
import { SessionRecorder } from "@emerge/replay";

const recorder = new SessionRecorder({ path: "/tmp/session.jsonl" });
const recordingProvider = recorder.wrap(realProvider);

const kernel = new Kernel({ provider: recordingProvider, telemetry });
await kernel.startSession();
// ... run agent ...
await kernel.endSession();
await recorder.flush();
```

## Quick example — replay

```ts
import { ReplayProvider } from "@emerge/replay";

const replayProvider = new ReplayProvider({ path: "/tmp/session.jsonl" });

// Zero real API calls — all responses served from the log.
const kernel = new Kernel({ provider: replayProvider, telemetry });
await kernel.startSession();
// ... run agent (identical file side-effects reproduced) ...
await kernel.endSession();
```

## Three reproducibility tiers

| Tier | Description |
|---|---|
| `record-replay` | Replays from log; fully deterministic; zero API cost |
| `pinned` | Best-effort with logged divergence |
| `free` | No reproducibility guarantees |

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
