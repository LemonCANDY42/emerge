/**
 * ReplayScrubber — browser replay controls.
 *
 * Shown only in replay mode (?mode=replay in URL).
 * State machine:
 *   cursor: 0..total
 *   playing: boolean
 *   speed: 1 | 2 | 4  (multiplier for auto-advance interval)
 *
 * Parent owns the cursor state; this component is a controlled component
 * that fires callbacks. This makes the scrubber fully testable without
 * side effects.
 *
 * Auto-advance: parent wires a useEffect that increments cursor at
 * (200ms / speed) interval. The scrubber provides the controls.
 */

import type React from "react";
import { useEffect, useRef } from "react";

interface ReplayScrubberProps {
  readonly total: number;
  readonly cursor: number;
  readonly playing: boolean;
  readonly speed: 1 | 2 | 4;
  readonly onCursorChange: (cursor: number) => void;
  readonly onPlayPause: () => void;
  readonly onSpeedChange: (speed: 1 | 2 | 4) => void;
}

const AUTO_ADVANCE_BASE_MS = 200;

export function ReplayScrubber({
  total,
  cursor,
  playing,
  speed,
  onCursorChange,
  onPlayPause,
  onSpeedChange,
}: ReplayScrubberProps): React.ReactElement {
  // Auto-advance timer
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!playing) {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      return;
    }
    if (cursor >= total) {
      onPlayPause(); // stop at end
      return;
    }
    timerRef.current = setTimeout(() => {
      onCursorChange(Math.min(cursor + 1, total));
    }, AUTO_ADVANCE_BASE_MS / speed);

    return () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
    };
  }, [playing, cursor, total, speed, onCursorChange, onPlayPause]);

  const clamp = (n: number) => Math.max(0, Math.min(n, total));

  const speedButtons: (1 | 2 | 4)[] = [1, 2, 4];

  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs font-mono">
      {/* Step back */}
      <button
        type="button"
        className="text-gray-400 hover:text-white disabled:text-gray-700 transition-colors"
        onClick={() => {
          if (playing) onPlayPause();
          onCursorChange(clamp(cursor - 1));
        }}
        disabled={cursor <= 0}
        aria-label="Step back"
      >
        &#9664;
      </button>

      {/* Play/Pause */}
      <button
        type="button"
        className="text-gray-300 hover:text-white transition-colors px-2 py-0.5 border border-gray-700 rounded"
        onClick={onPlayPause}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "⏸" : "▶"}
      </button>

      {/* Step forward */}
      <button
        type="button"
        className="text-gray-400 hover:text-white disabled:text-gray-700 transition-colors"
        onClick={() => {
          if (playing) onPlayPause();
          onCursorChange(clamp(cursor + 1));
        }}
        disabled={cursor >= total}
        aria-label="Step forward"
      >
        &#9654;
      </button>

      {/* Slider */}
      <input
        type="range"
        min={0}
        max={total}
        value={cursor}
        onChange={(e) => {
          if (playing) onPlayPause();
          onCursorChange(Number(e.target.value));
        }}
        className="flex-1 accent-purple-500"
        aria-label="Event cursor"
      />

      {/* Position label */}
      <span className="text-gray-500 w-20 text-right">
        {cursor} / {total}
      </span>

      {/* Speed selector */}
      <div className="flex gap-1">
        {speedButtons.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSpeedChange(s)}
            className={`px-1.5 py-0.5 rounded border text-xs transition-colors ${
              speed === s
                ? "bg-purple-600/30 border-purple-500 text-purple-300"
                : "border-gray-700 text-gray-600 hover:border-gray-500 hover:text-gray-400"
            }`}
            aria-label={`Speed ${s}x`}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  );
}
