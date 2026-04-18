/**
 * @emerge/dashboard server — HTTP + WebSocket server.
 *
 * Exposes startServer() for embedding in other processes and for the CLI.
 *
 * HTTP routes:
 *   GET /              → serve dist/client/index.html
 *   GET /assets/*      → serve hashed Vite bundle assets
 *   GET /api/health    → JSON health check
 *   GET /api/session.jsonl → raw JSONL content (for "download recording")
 *   GET /ws (upgrade)  → WebSocket event stream
 *
 * Security: default host is 127.0.0.1. Callers must explicitly pass
 * host: "0.0.0.0" and accept the warning that is printed to stderr.
 * WebSocket connections are guarded by Origin allowlist.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonlEvent } from "@emerge/kernel/contracts";
import { WebSocketServer } from "ws";
import { createBridge } from "./bridge.js";
import { readAllLines, tailFile } from "./tail.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** Where the Vite client bundle is written by `build:client`. */
const CLIENT_DIST = join(__dirname, "../../dist/client");

export type EventSource =
  | { readonly kind: "jsonl-tail"; readonly path: string }
  | { readonly kind: "jsonl-replay"; readonly path: string }
  | { readonly kind: "in-process"; readonly bus: InProcessBus };

/** Minimal in-process bus interface — callers subscribe then push events. */
export interface InProcessBus {
  subscribe(handler: (event: JsonlEvent) => void): () => void;
}

export interface ServerOptions {
  readonly port: number;
  readonly host: string;
  readonly source: EventSource;
  /**
   * Extra Origins to allow for WebSocket connections (in addition to the
   * default loopback allowlist). Each entry must be a fully-qualified origin
   * string, e.g. "http://my-internal-host:7777".
   */
  readonly allowOrigins?: readonly string[];
}

export interface ServerHandle {
  /** Stop accepting connections and clean up. */
  close(): Promise<void>;
  /** The port the server is actually listening on. */
  readonly port: number;
}

/**
 * Build the default WebSocket Origin allowlist.
 * Always includes loopback variants; if the server binds to a non-loopback
 * host the bound host+port is also added once the port is known.
 */
function buildOriginAllowlist(host: string, port: number, extra: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  // Loopback defaults
  allowed.add(`http://127.0.0.1:${port}`);
  allowed.add(`http://localhost:${port}`);
  // If the server is bound to something other than loopback, include it too
  if (host !== "127.0.0.1" && host !== "localhost") {
    allowed.add(`http://${host}:${port}`);
  }
  for (const o of extra) {
    allowed.add(o);
  }
  return allowed;
}

/**
 * Resolve and validate a URL path against a trusted root directory.
 * Returns the resolved absolute path if safe, or null if the path escapes root.
 *
 * Guards:
 *   1. Reject any URL containing ".." segments before path.join.
 *   2. After join+resolve, confirm the result is inside resolvedRoot.
 */
function resolveAssetPath(urlPath: string, rootDir: string): string | null {
  // Strip query string / fragment using the URL API
  let cleanPath: string;
  try {
    // Use a dummy base — we only care about the pathname
    cleanPath = new URL(urlPath, "http://x").pathname;
  } catch {
    return null;
  }

  // Belt-and-braces: reject any URL segment that is ".."
  if (cleanPath.split("/").some((seg) => seg === "..")) {
    return null;
  }

  const resolvedRoot = resolve(rootDir);
  const candidate = resolve(join(rootDir, cleanPath));

  // Ensure the resolved path is inside the root
  if (!candidate.startsWith(resolvedRoot + sep) && candidate !== resolvedRoot) {
    return null;
  }

  return candidate;
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const { port, host, source, allowOrigins = [] } = options;

  const bridge = createBridge();
  let stopSource: (() => void) | undefined;

  // ── Wire the event source ──────────────────────────────────────────────────

  if (source.kind === "jsonl-replay") {
    // Load the full file into history; no live updates
    const events = await readAllLines(source.path);
    bridge.load(events);
  } else if (source.kind === "jsonl-tail") {
    // Stat BEFORE reading so we capture the boundary atomically.
    // Events in [0, initialSize) are covered by readAllLines.
    // Events in [initialSize, ∞) are covered by the tailer.
    // Any bytes written in between will be re-read by the tailer since it
    // starts from initialSize, which was recorded before the read began.
    let initialSize = 0;
    try {
      initialSize = statSync(source.path).size;
    } catch {
      // File may not exist yet; tailer will start from 0
    }
    const initial = await readAllLines(source.path).catch(() => []);
    bridge.load(initial);
    const tailer = tailFile(source.path, (ev) => bridge.push(ev), initialSize);
    stopSource = () => tailer.stop();
  } else {
    // in-process bus
    const unsub = source.bus.subscribe((ev) => bridge.push(ev));
    stopSource = unsub;
  }

  // ── HTTP server ────────────────────────────────────────────────────────────

  const server = createServer((req, res) => {
    // Strip query string / fragment for routing — use pathname only
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://x").pathname;
    } catch {
      pathname = "/";
    }

    // Health endpoint
    if (pathname === "/api/health") {
      const body = JSON.stringify({
        ok: true,
        source: source.kind,
        connected: bridge.clientCount(),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    // Raw JSONL download
    if (pathname === "/api/session.jsonl") {
      if (source.kind === "in-process") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end("");
        return;
      }
      const jsonlPath = source.kind === "jsonl-tail" ? source.path : source.path;
      if (!existsSync(jsonlPath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": 'attachment; filename="session.jsonl"',
      });
      createReadStream(jsonlPath).pipe(res);
      return;
    }

    // Static client assets — only served if the client bundle has been built
    const clientDistExists = existsSync(CLIENT_DIST);

    if (pathname === "/" || pathname === "/index.html") {
      const indexPath = join(CLIENT_DIST, "index.html");
      if (clientDistExists && existsSync(indexPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        createReadStream(indexPath).pipe(res);
      } else {
        // Fallback: instruct user to build the client
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(placeholderHtml(port));
      }
      return;
    }

    // Assets (hashed filenames from Vite) — path traversal guarded
    if (pathname.startsWith("/assets/") && clientDistExists) {
      const assetPath = resolveAssetPath(pathname, CLIENT_DIST);
      if (assetPath !== null && existsSync(assetPath)) {
        const ct = guessMimeType(assetPath);
        res.writeHead(200, { "Content-Type": ct });
        createReadStream(assetPath).pipe(res);
        return;
      }
    }

    res.writeHead(404);
    res.end("Not found");
  });

  // ── WebSocket upgrade — Origin allowlist guard ─────────────────────────────

  const wss = new WebSocketServer({ server });

  // Origin allowlist: built once the port is known (after server.listen).
  // Stored in a mutable container so the connection handler closure can read
  // the populated value without capturing a stale undefined.
  const originGuard = { allowlist: undefined as Set<string> | undefined };

  wss.on("connection", (ws, req) => {
    // originGuard.allowlist is populated in the listen callback below; by the
    // time any connection arrives the server is already listening.
    //
    // Origin check: browsers always set the Origin header on WS upgrades.
    // Non-browser clients (curl, Node.js ws, CLI tools) typically do not.
    // We only reject connections where the Origin header is present AND not in
    // the allowlist — this closes the cross-site WebSocket hijacking vector
    // while allowing direct programmatic clients to connect.
    if (originGuard.allowlist !== undefined) {
      const origin = req.headers.origin;
      if (origin !== undefined && !originGuard.allowlist.has(origin)) {
        ws.close(1008, "Origin not allowed");
        return;
      }
    }
    bridge.addClient(ws);
    ws.on("close", () => bridge.removeClient(ws));
    ws.on("error", () => bridge.removeClient(ws));
  });

  // ── Start listening ────────────────────────────────────────────────────────

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const actualPort = (server.address() as { port: number }).port;

  // Build the origin allowlist now that we know the actual port
  originGuard.allowlist = buildOriginAllowlist(host, actualPort, allowOrigins);

  // Warn if non-loopback with no explicit extra origins
  if (host !== "127.0.0.1" && host !== "localhost" && allowOrigins.length === 0) {
    process.stderr.write(
      `[emerge-dashboard] WARNING: server bound to ${host}. WebSocket Origin check uses default allowlist only. Use allowOrigins option to explicitly allow remote origins.\n`,
    );
  }

  return {
    port: actualPort,

    async close(): Promise<void> {
      bridge.stop();
      stopSource?.();

      // Terminate active WebSocket connections so the server can shut down
      // cleanly in tests and CI. ws.close() alone only stops accepting new
      // connections; existing connections keep the process alive.
      for (const client of wss.clients) {
        client.terminate();
      }

      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });

      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function placeholderHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>emerge dashboard</title></head>
<body style="font-family:monospace;padding:2rem">
<h1>emerge dashboard server is running on port ${port}</h1>
<p>The browser client bundle has not been built yet.</p>
<p>Run: <code>pnpm --filter @emerge/dashboard build:client</code></p>
<p>Then restart this server.</p>
<p>WebSocket stream: <a href="ws://localhost:${port}">ws://localhost:${port}</a></p>
</body>
</html>`;
}

function guessMimeType(filePath: string): string {
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "application/javascript";
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}
