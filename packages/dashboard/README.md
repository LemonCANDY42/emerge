# @emerge/dashboard

Browser-based monitor for emerge agent sessions. Streams JSONL events over WebSocket to a React+Vite client.

## Security model

**No authentication.** The dashboard is designed for local development use. Treat it like any other local dev server.

### Default configuration (safe)

- Binds to `127.0.0.1` (loopback) by default. No external network reachability.
- WebSocket connections are guarded by an **Origin allowlist**. Only requests whose `Origin` header matches one of the following are accepted:
  - `http://127.0.0.1:<port>`
  - `http://localhost:<port>`
- This prevents other browser tabs (including pages from `http://evil.example.com`) from reading the WebSocket event stream, which may contain user prompts or other sensitive data.

### `--listen 0.0.0.0` is unsafe outside trusted networks

If you pass `--listen 0.0.0.0` (or any non-loopback address), the dashboard is reachable from the network. A warning is printed to stderr. There is no authentication; anyone who can reach the port can read your agent event stream.

Use `--listen 0.0.0.0` only in:
- Isolated CI environments
- Private LANs you fully control
- Docker containers with appropriate firewall rules

### Origin allowlist for non-loopback setups

When the server is bound to a non-loopback address, the default allowlist still only contains the loopback variants. Use the `allowOrigins` option (programmatic API) to explicitly allow additional origins:

```ts
await startServer({
  port: 7777,
  host: "0.0.0.0",
  source: { kind: "jsonl-tail", path: "/tmp/session.jsonl" },
  allowOrigins: ["http://my-internal-host:7777"],
});
```

A startup warning is printed to stderr when the server is bound non-locally and no extra origins are provided.

### Summary

| Scenario | Safe? | Notes |
|---|---|---|
| Default `127.0.0.1` (loopback) | Yes | Origin allowlist enforced |
| `--listen localhost` | Yes | Same as loopback |
| `--listen 0.0.0.0` on trusted LAN | Caution | Network-reachable, no auth |
| `--listen 0.0.0.0` on public network | No | Do not do this |

See [docs/cli/dashboard.md](../../docs/cli/dashboard.md) for CLI flag reference and security summary.

## Building

```bash
# Server (TypeScript)
pnpm --filter @emerge/dashboard build

# Client (Vite)
pnpm --filter @emerge/dashboard build:client
```

## Running

```bash
# Replay a recorded session
emerge-dashboard --session .emerge/session.jsonl

# Live-tail a running session
emerge-dashboard --jsonl /tmp/emerge-live/session.jsonl --port 7777
```
