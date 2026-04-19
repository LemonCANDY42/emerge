# @lwrf42/emerge-tui

Ink+React terminal UI monitor for emerge agent sessions: live topology, verdicts, cost, and replay scrubber.

v0.1.0 — early. TUI live and replay modes verified via Ink testing-library tests — see VERIFICATION.md.

## Install

```bash
npm install -g @lwrf42/emerge-tui
```

Or run without installing:

```bash
npx @lwrf42/emerge-tui --jsonl /tmp/emerge/session.jsonl
```

## Usage

```bash
# Live-tail a running session
emerge-tui --jsonl /tmp/emerge/session.jsonl

# Replay a recorded session with scrubbing
emerge-tui --replay session.jsonl

# Attach to a named session
emerge-tui --session my-session
```

## What it shows

- Agent topology tree (supervisor / workers / agents)
- Turn-by-turn verdict feed (aligned / partial / failed)
- Real-time cost accumulation per agent and session total
- Replay scrubber: step forward/back through recorded events

## Programmatic API

```ts
import { renderTui } from "@lwrf42/emerge-tui";
import { TuiState } from "@lwrf42/emerge-tui/state";

const state = new TuiState();
const { unmount } = renderTui({ state });

// Feed events from your kernel:
kernel.on("event", (evt) => state.ingest(evt));
```

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
