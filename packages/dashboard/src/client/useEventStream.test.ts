/**
 * Tests for the useEventStream hook.
 *
 * Uses a tiny EventTarget-based WebSocket stub that bypasses the network.
 * The stub exposes a `push` method so tests can deliver frames synchronously.
 *
 * @vitest-environment jsdom
 */

import { JSONL_SCHEMA_VERSION } from "@emerge/kernel/contracts";
import type { JsonlEvent } from "@emerge/kernel/contracts";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── WebSocket stub ────────────────────────────────────────────────────────────

interface StubWs {
  push(frame: unknown): void;
  close(): void;
}

let stubInstances: StubWs[] = [];

class StubWebSocket {
  static readonly OPEN = 1;
  readyState = 1;
  readonly url: string;

  onopen: ((evt: Event) => void) | null = null;
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onclose: ((evt: Event) => void) | null = null;
  onerror: ((evt: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    stubInstances.push(this as unknown as StubWs);
    // Trigger open asynchronously
    setTimeout(() => {
      this.onopen?.(new Event("open"));
    }, 0);
  }

  send(_data: string): void {}

  close(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.(new Event("close"));
  }

  /** Helper used by tests to push a frame to the hook. */
  push(frame: unknown): void {
    const evt = new MessageEvent("message", {
      data: JSON.stringify(frame),
    });
    this.onmessage?.(evt);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLifecycle(at: number): JsonlEvent {
  return {
    v: JSONL_SCHEMA_VERSION,
    type: "lifecycle",
    at,
    agent: "agent-a" as import("@emerge/kernel/contracts").AgentId,
    transition: "running" as import("@emerge/kernel/contracts").AgentState,
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("useEventStream", () => {
  beforeEach(() => {
    stubInstances = [];
    // Replace global WebSocket with the stub
    // biome-ignore lint/suspicious/noExplicitAny: test stub requires any cast
    (globalThis as any).WebSocket = StubWebSocket;
    // Provide minimal window.location for URL derivation
    if (!("location" in globalThis)) {
      // biome-ignore lint/suspicious/noExplicitAny: test environment setup
      (globalThis as any).window = { location: { protocol: "http:", host: "localhost:7777" } };
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with connecting status", async () => {
    const { useEventStream } = await import("./useEventStream.js");
    const { result } = renderHook(() => useEventStream("ws://localhost:7777"));
    expect(result.current.connectionStatus).toBe("connecting");
  });

  it("applies init frame to build TuiState", async () => {
    const { useEventStream } = await import("./useEventStream.js");
    const { result } = renderHook(() => useEventStream("ws://localhost:7777"));

    const events: JsonlEvent[] = [makeSessionStart(1000), makeLifecycle(2000)];

    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 20));
      const ws = stubInstances[0] as unknown as StubWebSocket;
      ws.push({ type: "init", events });
    });

    expect(result.current.eventCount).toBe(2);
    expect(result.current.connectionStatus).toBe("live");
    // lifecycle event at 2000 should update tuiState.agents
    expect(result.current.tuiState.agents.size).toBe(1);
  });

  it("applies subsequent event frames", async () => {
    const { useEventStream } = await import("./useEventStream.js");
    const { result } = renderHook(() => useEventStream("ws://localhost:7777"));

    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 20));
      const ws = stubInstances[0] as unknown as StubWebSocket;
      ws.push({ type: "init", events: [makeSessionStart(1000)] });
    });

    expect(result.current.eventCount).toBe(1);

    await act(async () => {
      const ws = stubInstances[0] as unknown as StubWebSocket;
      ws.push({ type: "event", event: makeLifecycle(2000) });
    });

    expect(result.current.eventCount).toBe(2);
    expect(result.current.tuiState.agents.size).toBe(1);
  });

  it("ping frames are ignored", async () => {
    const { useEventStream } = await import("./useEventStream.js");
    const { result } = renderHook(() => useEventStream("ws://localhost:7777"));

    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 20));
      const ws = stubInstances[0] as unknown as StubWebSocket;
      ws.push({ type: "init", events: [] });
      ws.push({ type: "ping" });
    });

    expect(result.current.eventCount).toBe(0);
    expect(result.current.connectionStatus).toBe("live");
  });

  it("transitions to disconnected on WS close", async () => {
    const { useEventStream } = await import("./useEventStream.js");
    const { result } = renderHook(() => useEventStream("ws://localhost:7777"));

    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 20));
      const ws = stubInstances[0] as unknown as StubWebSocket;
      ws.push({ type: "init", events: [] });
      ws.close();
    });

    expect(result.current.connectionStatus).toBe("disconnected");
  });

  it("malformed WS frame is silently dropped", async () => {
    const { useEventStream } = await import("./useEventStream.js");
    const { result } = renderHook(() => useEventStream("ws://localhost:7777"));

    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 20));
      const ws = stubInstances[0] as unknown as StubWebSocket;
      ws.push({ type: "init", events: [] });
      // Send a non-JSON message directly via the handler
      const badEvt = new MessageEvent("message", { data: "NOT JSON AT ALL" });
      ws.onmessage?.(badEvt);
    });

    // Event count should remain 0; no crash
    expect(result.current.eventCount).toBe(0);
  });
});
