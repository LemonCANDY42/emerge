/**
 * useEventStream — React hook for the WebSocket event stream.
 *
 * Connects to the dashboard server, dispatches incoming WS frames through
 * the shared TUI reducer (imported from @emerge/tui/state), and exposes the
 * derived state.
 *
 * WS frame types handled:
 *   { type: "init",  events: JsonlEvent[] }  → replay full history into state
 *   { type: "event", event: JsonlEvent }     → single event dispatch
 *   { type: "ping" }                         → ignored (keepalive)
 *
 * Auto-reconnect: exponential backoff starting at 500ms, capped at 30s.
 *
 * Design: DashboardState wraps TuiState and adds WebSocket connection state.
 * Keeping them separate makes it trivial to add more dashboard-specific fields
 * later without touching the reducer contract.
 *
 * Replay mode: when `accumulateRaw` is true (set by App.tsx in replay mode),
 * the raw JsonlEvent array is also maintained in state so the scrubber can
 * reconstruct intermediate states by calling applyEvents(rawEvents.slice(0, cursor)).
 */

import type { JsonlEvent } from "@emerge/kernel/contracts";
import { EMPTY_STATE, applyEvent, applyEvents } from "@emerge/tui/state";
import type { TuiState } from "@emerge/tui/state";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

export type ConnectionStatus = "connecting" | "live" | "disconnected";

export interface DashboardState {
  readonly tuiState: TuiState;
  readonly connectionStatus: ConnectionStatus;
  readonly eventCount: number;
  /**
   * Raw event log — only populated when accumulateRaw is true.
   * Used by the replay scrubber to reconstruct state at a given cursor position.
   */
  readonly rawEvents: readonly JsonlEvent[];
}

type Action =
  | { readonly type: "INIT"; readonly events: readonly JsonlEvent[]; readonly accumulate: boolean }
  | { readonly type: "EVENT"; readonly event: JsonlEvent; readonly accumulate: boolean }
  | { readonly type: "STATUS"; readonly status: ConnectionStatus };

function dashReducer(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case "INIT": {
      const tuiState = applyEvents(action.events);
      return {
        ...state,
        tuiState,
        eventCount: action.events.length,
        connectionStatus: "live",
        rawEvents: action.accumulate ? action.events : [],
      };
    }
    case "EVENT": {
      const tuiState = applyEvent(state.tuiState, action.event);
      return {
        ...state,
        tuiState,
        eventCount: state.eventCount + 1,
        rawEvents: action.accumulate ? [...state.rawEvents, action.event] : state.rawEvents,
      };
    }
    case "STATUS":
      return { ...state, connectionStatus: action.status };
  }
}

const INITIAL_STATE: DashboardState = {
  tuiState: EMPTY_STATE,
  connectionStatus: "connecting",
  eventCount: 0,
  rawEvents: [],
};

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

export interface UseEventStreamOptions {
  /** WebSocket URL override (defaults to current page origin). */
  wsUrl?: string;
  /**
   * When true, raw JsonlEvents are accumulated in state.rawEvents.
   * Gate this on replay mode to avoid unbounded memory growth in live mode.
   */
  accumulateRaw?: boolean;
}

export function useEventStream(wsUrlOrOptions?: string | UseEventStreamOptions): DashboardState {
  // Support legacy positional-string call signature
  const opts: UseEventStreamOptions =
    typeof wsUrlOrOptions === "string" ? { wsUrl: wsUrlOrOptions } : (wsUrlOrOptions ?? {});

  const { wsUrl, accumulateRaw = false } = opts;

  const [state, dispatch] = useReducer(dashReducer, INITIAL_STATE);
  const backoffRef = useRef(MIN_BACKOFF_MS);
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false);
  // Keep a stable ref to accumulateRaw so the connect callback doesn't need
  // to be recreated every time it changes.
  const accumulateRef = useRef(accumulateRaw);
  accumulateRef.current = accumulateRaw;

  // Derive WS URL from current page if not provided
  const resolvedUrl =
    wsUrl ??
    (() => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${window.location.host}`;
    })();

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    dispatch({ type: "STATUS", status: "connecting" });

    const ws = new WebSocket(resolvedUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (unmountedRef.current) {
        ws.close();
        return;
      }
      backoffRef.current = MIN_BACKOFF_MS;
    };

    ws.onmessage = (evt) => {
      if (unmountedRef.current) return;
      let frame: unknown;
      try {
        frame = JSON.parse(String(evt.data));
      } catch {
        return;
      }
      if (typeof frame !== "object" || frame === null) return;

      const f = frame as Record<string, unknown>;
      const frameType = f.type;
      const accumulate = accumulateRef.current;

      if (frameType === "init" && Array.isArray(f.events)) {
        dispatch({ type: "INIT", events: f.events as JsonlEvent[], accumulate });
      } else if (frameType === "event" && f.event != null) {
        dispatch({ type: "EVENT", event: f.event as JsonlEvent, accumulate });
      }
      // "ping" frames are silently ignored
    };

    ws.onclose = () => {
      if (unmountedRef.current) return;
      dispatch({ type: "STATUS", status: "disconnected" });

      // Exponential backoff reconnect
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror — reconnect logic lives there
    };
  }, [resolvedUrl]);

  useEffect(() => {
    unmountedRef.current = false;
    connect();
    return () => {
      unmountedRef.current = true;
      wsRef.current?.close();
    };
  }, [connect]);

  return state;
}
