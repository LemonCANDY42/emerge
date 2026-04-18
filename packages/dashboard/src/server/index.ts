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
 */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
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
}

export interface ServerHandle {
  /** Stop accepting connections and clean up. */
  close(): Promise<void>;
  /** The port the server is actually listening on. */
  readonly port: number;
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const { port, host, source } = options;

  const bridge = createBridge();
  let stopSource: (() => void) | undefined;

  // ── Wire the event source ──────────────────────────────────────────────────

  if (source.kind === "jsonl-replay") {
    // Load the full file into history; no live updates
    const events = await readAllLines(source.path);
    bridge.load(events);
  } else if (source.kind === "jsonl-tail") {
    // Load existing content first, then tail for NEW lines only.
    // We stat the file after loading to get the byte offset, then start
    // the tailer from that offset so we don't deliver events twice.
    const initial = await readAllLines(source.path).catch(() => []);
    bridge.load(initial);
    let initialOffset = 0;
    try {
      const { statSync } = await import("node:fs");
      initialOffset = statSync(source.path).size;
    } catch {
      // File may not exist yet; tailer will start from 0
    }
    const tailer = tailFile(source.path, (ev) => bridge.push(ev), initialOffset);
    stopSource = () => tailer.stop();
  } else {
    // in-process bus
    const unsub = source.bus.subscribe((ev) => bridge.push(ev));
    stopSource = unsub;
  }

  // ── HTTP server ────────────────────────────────────────────────────────────

  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    // Health endpoint
    if (url === "/api/health") {
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
    if (url === "/api/session.jsonl") {
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

    if (url === "/" || url === "/index.html") {
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

    // Assets (hashed filenames from Vite)
    if (url.startsWith("/assets/") && clientDistExists) {
      const assetPath = join(CLIENT_DIST, url);
      if (existsSync(assetPath)) {
        const ct = guessMimeType(assetPath);
        res.writeHead(200, { "Content-Type": ct });
        createReadStream(assetPath).pipe(res);
        return;
      }
    }

    res.writeHead(404);
    res.end("Not found");
  });

  // ── WebSocket upgrade ──────────────────────────────────────────────────────

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
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

  return {
    port: actualPort,

    async close(): Promise<void> {
      bridge.stop();
      stopSource?.();

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
