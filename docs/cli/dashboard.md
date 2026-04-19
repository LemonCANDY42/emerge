# emerge dashboard CLI

The `emerge dashboard` subcommand launches a browser-based monitor for agent sessions. It shells out to the `emerge-dashboard` binary shipped by `@lwrf42/emerge-dashboard`.

## Usage

```bash
# Replay a recorded session (static snapshot)
emerge dashboard --session .emerge/session-abc.jsonl

# Live-tail a running session
emerge dashboard --jsonl /tmp/emerge-live/session.jsonl

# Custom port
emerge dashboard --session path.jsonl --port 8080

# Expose to the network (with warning)
emerge dashboard --jsonl path.jsonl --listen 0.0.0.0
```

## Options

| Flag | Default | Description |
|---|---|---|
| `--session <path>` | — | JSONL file to replay (static, full history) |
| `--jsonl <path>` | — | JSONL file to tail (live updates as events arrive) |
| `--port <n>` | 7777 | HTTP + WebSocket port |
| `--listen <host>` | 127.0.0.1 | Bind host; use `0.0.0.0` for network exposure (warning printed) |

Exactly one of `--session` or `--jsonl` is required. They are mutually exclusive.

## Building the client

The browser client is built separately from the TypeScript server code:

```bash
# Build server (TypeScript → dist/server/)
pnpm --filter @lwrf42/emerge-dashboard build

# Build client (Vite → dist/client/)
pnpm --filter @lwrf42/emerge-dashboard build:client
```

The client build is intentionally excluded from the default `pnpm build` chain to keep CI fast. Run both for a fully functional dashboard.

## How it works

`emerge dashboard` shells out to `emerge-dashboard` without duplicating server logic. This keeps `@lwrf42/emerge-cli` free of Node HTTP and WebSocket dependencies.

The dashboard server:
1. Reads/tails the JSONL file
2. Serves the prebuilt Vite client bundle on `http://host:port/`
3. Streams events via WebSocket to connected browsers
4. Exposes `/api/health` (JSON) and `/api/session.jsonl` (raw JSONL download)

## Security

The dashboard has **no authentication**. It is designed for local development only.

| Property | Value |
|---|---|
| Default bind | `127.0.0.1` (loopback only) |
| `--listen 0.0.0.0` | Unsafe outside trusted networks — prints a warning |
| WebSocket Origin | Allowlist enforced; defaults to `http://127.0.0.1:<port>` and `http://localhost:<port>` |
| Auth | None |

A WebSocket connection whose `Origin` header is not in the allowlist is rejected with close code 1008. This prevents arbitrary browser tabs from reading the event stream (which may contain user prompts or provider call payloads).

For detailed information including the `allowOrigins` API option, see [packages/dashboard/README.md](../../packages/dashboard/README.md).

## EMERGE_DASHBOARD=1 integration

The `topology-supervisor-worker` demo supports an opt-in dashboard mode:

```bash
EMERGE_DASHBOARD=1 node examples/topology-supervisor-worker/dist/index.js
```

This writes the session JSONL to a temp file and spawns `emerge-dashboard --jsonl <path>` in the background. The URL is printed to stdout. The demo completes normally; the server stays up for 5 seconds then exits.
