/**
 * Bridge — translates event sources to WebSocket frames.
 *
 * Frame format (all JSON, newline-terminated):
 *   { type: "init",  events: JsonlEvent[] }   — sent once to each new client (full history)
 *   { type: "event", event: JsonlEvent }       — subsequent events
 *   { type: "ping" }                           — keepalive, every 30s
 *
 * The bridge owns the event accumulator so new clients always receive the
 * full session history up to the moment of their connection.
 */

import type { JsonlEvent } from "@lwrf42/emerge-kernel/contracts";
import type { WebSocket } from "ws";

const PING_INTERVAL_MS = 30_000;

export type WsFrame =
  | { readonly type: "init"; readonly events: readonly JsonlEvent[] }
  | { readonly type: "event"; readonly event: JsonlEvent }
  | { readonly type: "ping" };

/** Send a frame to a single client, swallowing errors for closed sockets. */
function sendFrame(ws: WebSocket, frame: WsFrame): void {
  if (ws.readyState !== 1 /* OPEN */) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // Socket may have closed between readyState check and send — ignore
  }
}

export interface Bridge {
  /** Register a new WebSocket client — sends the init frame immediately. */
  addClient(ws: WebSocket): void;
  /** Remove a client on disconnect. */
  removeClient(ws: WebSocket): void;
  /** Push a new event from the source; broadcasts to all connected clients. */
  push(event: JsonlEvent): void;
  /** Pre-load the event history (used for replay mode initial state). */
  load(events: readonly JsonlEvent[]): void;
  /** Number of currently connected clients. */
  clientCount(): number;
  /** All events accumulated so far. */
  events(): readonly JsonlEvent[];
  /** Stop the keepalive timer. */
  stop(): void;
}

export function createBridge(): Bridge {
  const accumulated: JsonlEvent[] = [];
  const clients = new Set<WebSocket>();

  // Keepalive ping every 30s to all connected clients
  const pingTimer = setInterval(() => {
    for (const ws of clients) {
      sendFrame(ws, { type: "ping" });
    }
  }, PING_INTERVAL_MS);

  // Prevent the timer from keeping the process alive
  pingTimer.unref();

  return {
    addClient(ws: WebSocket): void {
      clients.add(ws);
      // Send full history as init frame
      sendFrame(ws, { type: "init", events: [...accumulated] });
    },

    removeClient(ws: WebSocket): void {
      clients.delete(ws);
    },

    push(event: JsonlEvent): void {
      accumulated.push(event);
      for (const ws of clients) {
        sendFrame(ws, { type: "event", event });
      }
    },

    load(events: readonly JsonlEvent[]): void {
      accumulated.push(...events);
    },

    clientCount(): number {
      return clients.size;
    },

    events(): readonly JsonlEvent[] {
      return [...accumulated];
    },

    stop(): void {
      clearInterval(pingTimer);
    },
  };
}
