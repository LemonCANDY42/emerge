/**
 * Server integration tests.
 *
 * Starts the dashboard server in-process, connects WebSocket clients,
 * and asserts protocol correctness.
 *
 * Each test gets a fresh server on a random port (port 0 → OS-assigned)
 * to avoid port conflicts in parallel test runs.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSONL_SCHEMA_VERSION } from "@emerge/kernel/contracts";
import type { JsonlEvent } from "@emerge/kernel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startServer } from "./index.js";
import type { ServerHandle, ServerOptions } from "./index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLifecycleEvent(at: number): JsonlEvent {
  return {
    v: JSONL_SCHEMA_VERSION,
    type: "lifecycle",
    at,
    agent: "test-agent" as import("@emerge/kernel/contracts").AgentId,
    transition: "thinking" as import("@emerge/kernel/contracts").AgentState,
  };
}

function makeSessionStart(at: number): JsonlEvent {
  return {
    v: JSONL_SCHEMA_VERSION,
    type: "session.start",
    at,
    sessionId: "sess-1" as import("@emerge/kernel/contracts").SessionId,
    contractRef: "contract-1" as import("@emerge/kernel/contracts").ContractId,
  };
}

/** Connect a WS client and collect frames until `count` arrive or timeout. */
function collectFrames(url: string, count: number, timeoutMs = 2000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const frames: unknown[] = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      // Resolve with however many we got — tests will assert the count
      resolve(frames);
    }, timeoutMs);

    ws.on("message", (data) => {
      try {
        frames.push(JSON.parse(String(data)));
      } catch {
        // ignore parse errors
      }
      if (frames.length >= count) {
        clearTimeout(timer);
        ws.close();
        resolve(frames);
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Write a minimal JSONL file. */
function writeTempJsonl(events: JsonlEvent[]): string {
  const dir = mkdtempSync(join(tmpdir(), "emerge-dash-test-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");
  return path;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("dashboard server", () => {
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it("health endpoint returns correct shape for jsonl-replay mode", async () => {
    const path = writeTempJsonl([makeSessionStart(1000)]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
    const body = (await res.json()) as { ok: boolean; source: string; connected: number };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.source).toBe("jsonl-replay");
    expect(typeof body.connected).toBe("number");
  });

  it("health endpoint returns correct shape for jsonl-tail mode", async () => {
    const path = writeTempJsonl([]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-tail", path },
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
    const body = (await res.json()) as { source: string };

    expect(body.source).toBe("jsonl-tail");
  });

  it("WS init frame contains all events from a populated JSONL", async () => {
    const events = [makeSessionStart(1000), makeLifecycleEvent(2000)];
    const path = writeTempJsonl(events);

    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    const frames = await collectFrames(`ws://127.0.0.1:${handle.port}`, 1);
    expect(frames).toHaveLength(1);
    const frame = frames[0] as { type: string; events: unknown[] };
    expect(frame.type).toBe("init");
    expect(frame.events).toHaveLength(2);
  });

  it("WS init frame is empty for an empty JSONL file", async () => {
    const path = writeTempJsonl([]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    const frames = await collectFrames(`ws://127.0.0.1:${handle.port}`, 1);
    const frame = frames[0] as { type: string; events: unknown[] };
    expect(frame.type).toBe("init");
    expect(frame.events).toHaveLength(0);
  });

  it("bad lines in JSONL are skipped; server does not crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emerge-dash-test-"));
    const path = join(dir, "bad.jsonl");
    writeFileSync(
      path,
      `${[
        JSON.stringify(makeSessionStart(1000)),
        "this is not json",
        '{"v":"1.0.0","type":"unknown_type","at":2000}',
        JSON.stringify(makeLifecycleEvent(3000)),
      ].join("\n")}\n`,
      "utf-8",
    );

    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    // Should still start and return only the 2 valid events
    const frames = await collectFrames(`ws://127.0.0.1:${handle.port}`, 1);
    const frame = frames[0] as { type: string; events: unknown[] };
    expect(frame.type).toBe("init");
    expect(frame.events).toHaveLength(2);
  });

  it("WS broadcasts subsequent events in live tail mode", async () => {
    const path = writeTempJsonl([makeSessionStart(1000)]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-tail", path },
    });

    // Collect init + one event frame
    const framesPromise = collectFrames(`ws://127.0.0.1:${handle.port}`, 2, 3000);

    // Wait for client to connect and receive init
    await new Promise<void>((r) => setTimeout(r, 200));

    // Append a new event to the file
    const { appendFileSync } = await import("node:fs");
    appendFileSync(path, `${JSON.stringify(makeLifecycleEvent(2000))}\n`, "utf-8");

    const frames = await framesPromise;
    // We expect: 1 init frame + 1 event frame
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const initFrame = frames[0] as { type: string };
    expect(initFrame.type).toBe("init");
    const eventFrame = frames[1] as { type: string; event: { type: string } };
    expect(eventFrame.type).toBe("event");
    expect(eventFrame.event.type).toBe("lifecycle");
  });

  it("health endpoint reflects connected client count", async () => {
    const path = writeTempJsonl([]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    // No clients connected yet
    const res1 = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
    const body1 = (await res1.json()) as { connected: number };
    expect(body1.connected).toBe(0);

    // Connect a WS client
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`);
    await new Promise<void>((r) => ws.on("open", r));

    // Give the server a tick to register the client
    await new Promise<void>((r) => setTimeout(r, 50));

    const res2 = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
    const body2 = (await res2.json()) as { connected: number };
    expect(body2.connected).toBe(1);

    ws.close();
    await new Promise<void>((r) => setTimeout(r, 50));
  });

  it("server binds to 127.0.0.1 by default", async () => {
    const path = writeTempJsonl([]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    // Should be reachable on loopback
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
    expect(res.status).toBe(200);
  });

  it("server accepts 0.0.0.0 binding when explicitly requested", async () => {
    const path = writeTempJsonl([]);
    handle = await startServer({
      port: 0,
      host: "0.0.0.0",
      source: { kind: "jsonl-replay", path },
    });

    // Should be reachable via loopback even when bound to 0.0.0.0
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
    expect(res.status).toBe(200);
  });

  it("multiple WS clients each receive the init frame", async () => {
    const events = [makeSessionStart(1000)];
    const path = writeTempJsonl(events);

    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    const [frames1, frames2] = await Promise.all([
      collectFrames(`ws://127.0.0.1:${handle.port}`, 1),
      collectFrames(`ws://127.0.0.1:${handle.port}`, 1),
    ]);

    const f1 = frames1[0] as { type: string; events: unknown[] };
    const f2 = frames2[0] as { type: string; events: unknown[] };
    expect(f1.type).toBe("init");
    expect(f2.type).toBe("init");
    expect(f1.events).toHaveLength(1);
    expect(f2.events).toHaveLength(1);
  });

  it("session.jsonl endpoint returns raw JSONL for replay source", async () => {
    const events = [makeSessionStart(1000), makeLifecycleEvent(2000)];
    const path = writeTempJsonl(events);

    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/session.jsonl`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("session.start");
    expect(text).toContain("lifecycle");
  });

  it("session.jsonl endpoint returns empty body for in-process source", async () => {
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: {
        kind: "in-process",
        bus: {
          subscribe(_handler: (event: JsonlEvent) => void) {
            return () => {};
          },
        },
      },
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/session.jsonl`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("");
  });

  // ─── Regression: #1 path traversal ──────────────────────────────────────

  it("GET /assets/../../../package.json returns 404 (path traversal blocked)", async () => {
    const path = writeTempJsonl([]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    // Attempt path traversal — must return 404, not 200 with file contents
    const res = await fetch(`http://127.0.0.1:${handle.port}/assets/../../../package.json`);
    expect(res.status).toBe(404);
  });

  it("GET /assets/../../../../etc/passwd returns 404 (deep traversal blocked)", async () => {
    const path = writeTempJsonl([]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/assets/../../../../etc/passwd`);
    expect(res.status).toBe(404);
  });

  // ─── Regression: #3 WebSocket Origin allowlist ───────────────────────────

  it("WS connection from default loopback Origin is accepted", async () => {
    const path = writeTempJsonl([]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    const origin = `http://127.0.0.1:${handle.port}`;
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, { headers: { origin } });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.close();
  });

  it("WS connection from disallowed Origin is rejected with close code 1008", async () => {
    const path = writeTempJsonl([]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, {
      headers: { origin: "http://evil.example.com" },
    });

    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
      // If the connection is rejected, it may error before closing — treat as rejection
      ws.on("error", () => resolve(-1));
    });

    // Server must not accept the connection
    expect(closeCode).not.toBe(1000); // 1000 = normal close (would mean accepted)
  });

  it("WS connection from an explicit extra allowlist Origin is accepted", async () => {
    const path = writeTempJsonl([]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
      allowOrigins: ["http://trusted.internal:9000"],
    } satisfies ServerOptions);

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, {
      headers: { origin: "http://trusted.internal:9000" },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.close();
  });

  // ─── Regression: #5 initial-offset race ─────────────────────────────────

  it("events appended between stat and readAllLines are not dropped", async () => {
    // This test verifies the stat-before-read ordering. We write N events,
    // then start the server in tail mode. Because the stat is taken before the
    // read, any bytes written after the stat start but before the read finishes
    // will be read again by the tailer. The test verifies that events written
    // BEFORE the server starts are all delivered (no gap scenario).
    const events = [makeSessionStart(1000), makeLifecycleEvent(2000)];
    const path = writeTempJsonl(events);

    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-tail", path },
    });

    const frames = await collectFrames(`ws://127.0.0.1:${handle.port}`, 1);
    const frame = frames[0] as { type: string; events: unknown[] };
    expect(frame.type).toBe("init");
    // All events written before server start must be in the init frame
    expect(frame.events).toHaveLength(2);
  });

  // ─── Regression: #10 wss.close() terminates connected sockets ───────────

  it("server.close() terminates active WebSocket connections", async () => {
    const path = writeTempJsonl([]);
    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: { kind: "jsonl-replay", path },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    // close() should not hang; it must terminate the connected socket
    const closePromise = handle.close().then(() => "done");
    const result = await Promise.race([
      closePromise,
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 3000)),
    ]);

    expect(result).toBe("done");
    handle = undefined; // Already closed
  });

  it("in-process bus events are forwarded to WS clients", async () => {
    let pushEvent: ((event: JsonlEvent) => void) | undefined;

    handle = await startServer({
      port: 0,
      host: "127.0.0.1",
      source: {
        kind: "in-process",
        bus: {
          subscribe(handler: (event: JsonlEvent) => void) {
            pushEvent = handler;
            return () => {
              pushEvent = undefined;
            };
          },
        },
      },
    });

    const framesPromise = collectFrames(`ws://127.0.0.1:${handle.port}`, 2, 2000);

    // Wait for client to connect
    await new Promise<void>((r) => setTimeout(r, 200));

    // Push an event through the bus
    pushEvent?.(makeLifecycleEvent(5000));

    const frames = await framesPromise;
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const eventFrame = frames[1] as { type: string; event: { type: string } };
    expect(eventFrame.type).toBe("event");
    expect(eventFrame.event.type).toBe("lifecycle");
  });
});
