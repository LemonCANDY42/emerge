/**
 * ReplayApp — interactive scrubber for JSONL replay.
 *
 * Keyboard:
 *   ← / →     step one event
 *   ↑ / ↓     jump 10 events
 *   space      toggle play/pause (auto-advance every 200ms)
 *   home       jump to first event
 *   end        jump to last event
 *   q          quit
 *
 * State machine:
 *   cursor: 0..events.length (exclusive upper bound)
 *   playing: boolean
 *
 * The component recomputes TuiState from scratch on every cursor change by
 * slicing the event array. This is O(cursor) but sessions are typically <10k
 * events — acceptable for Phase 1.
 */

import type { JsonlEvent } from "@lwrf42/emerge-kernel/contracts";
import { useApp, useInput } from "ink";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { applyEvents } from "../state/reducer.js";
import { EMPTY_STATE, type TuiState } from "../state/types.js";
import { Dashboard } from "./Dashboard.js";

const AUTO_ADVANCE_MS = 200;

interface ReplayAppProps {
  readonly events: readonly JsonlEvent[];
}

export function ReplayApp({ events }: ReplayAppProps): React.ReactElement {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Recompute state from events[0..cursor]
  const [tuiState, setTuiState] = useState<TuiState>(EMPTY_STATE);

  useEffect(() => {
    const slice = events.slice(0, cursor);
    setTuiState(applyEvents(slice));
  }, [cursor, events]);

  // Auto-advance when playing
  useEffect(() => {
    if (!playing) return;
    if (cursor >= events.length) {
      setPlaying(false);
      return;
    }

    const timer = setTimeout(() => {
      setCursor((c) => Math.min(c + 1, events.length));
    }, AUTO_ADVANCE_MS);

    return () => clearTimeout(timer);
  }, [playing, cursor, events.length]);

  const clamp = useCallback(
    (n: number) => Math.max(0, Math.min(n, events.length)),
    [events.length],
  );

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (input === " ") {
      setPlaying((p) => !p);
      return;
    }
    if (key.leftArrow) {
      setPlaying(false);
      setCursor((c) => clamp(c - 1));
      return;
    }
    if (key.rightArrow) {
      setPlaying(false);
      setCursor((c) => clamp(c + 1));
      return;
    }
    if (key.upArrow) {
      setPlaying(false);
      setCursor((c) => clamp(c - 10));
      return;
    }
    if (key.downArrow) {
      setPlaying(false);
      setCursor((c) => clamp(c + 10));
      return;
    }
    // Home key: ANSI \x1B[H or \x1B[1~
    if (input === "\x1B[H" || input === "\x1B[1~") {
      setPlaying(false);
      setCursor(0);
      return;
    }
    // End key: ANSI \x1B[F or \x1B[4~
    if (input === "\x1B[F" || input === "\x1B[4~") {
      setPlaying(false);
      setCursor(events.length);
      return;
    }
  });

  const currentEvent = cursor > 0 ? events[cursor - 1] : undefined;
  const currentKind = currentEvent?.type ?? "(none)";

  return (
    <Dashboard
      state={tuiState}
      mode="replay"
      replayStatus={{
        cursor,
        total: events.length,
        playing,
        currentKind,
      }}
    />
  );
}
