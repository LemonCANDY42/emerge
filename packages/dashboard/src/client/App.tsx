/**
 * App — top-level layout for the emerge dashboard.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────┐
 *   │ Header: session id + connection status pill         │
 *   ├──────────────────────┬──────────────────────────────┤
 *   │ TopologyGraph        │ VerdictExplorer (prominent)  │
 *   ├──────────────────────┼──────────────────────────────┤
 *   │ CostChart            │ TraceTimeline                │
 *   ├─────────────────────────────────────────────────────┤
 *   │ ReplayScrubber (replay mode only)                   │
 *   └─────────────────────────────────────────────────────┘
 *
 * Replay mode is detected when the URL contains ?mode=replay.
 * The scrubber tracks a cursor into the event log client-side.
 * In replay mode, rawEvents are accumulated so the scrubber can reconstruct
 * intermediate states: displayState = applyEvents(rawEvents.slice(0, cursor)).
 */

import { applyEvents } from "@lwrf42/emerge-tui/state";
import type React from "react";
import { useMemo, useState } from "react";
import { CostChart } from "./panels/CostChart.js";
import { ReplayScrubber } from "./panels/ReplayScrubber.js";
import { TopologyGraph } from "./panels/TopologyGraph.js";
import { TraceTimeline } from "./panels/TraceTimeline.js";
import { VerdictExplorer } from "./panels/VerdictExplorer.js";
import { useEventStream } from "./useEventStream.js";
import type { ConnectionStatus } from "./useEventStream.js";

// Detect replay mode from URL
const isReplayMode = new URLSearchParams(window.location.search).get("mode") === "replay";

function StatusPill({ status }: { status: ConnectionStatus }): React.ReactElement {
  const config = {
    connecting: {
      label: "connecting\u2026",
      className: "bg-yellow-500/20 text-yellow-300 border border-yellow-500/40",
    },
    live: {
      label: "live",
      className: "bg-green-500/20 text-green-300 border border-green-500/40",
    },
    disconnected: {
      label: "disconnected (auto-reconnecting)",
      className: "bg-red-500/20 text-red-300 border border-red-500/40",
    },
  } as const;

  const { label, className } = config[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${className}`}
    >
      {status === "live" && (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
      )}
      {label}
    </span>
  );
}

export function App(): React.ReactElement {
  const stream = useEventStream({ accumulateRaw: isReplayMode });
  const { tuiState, connectionStatus, eventCount, rawEvents } = stream;

  // Replay cursor — only used in replay mode
  const [cursor, setCursor] = useState<number>(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);

  // In replay mode, reconstruct state up to cursor from the raw event log.
  // In live mode, use the full tuiState from the stream.
  const displayState = useMemo(() => {
    if (isReplayMode && rawEvents.length > 0) {
      return applyEvents(rawEvents.slice(0, cursor));
    }
    return tuiState;
  }, [tuiState, rawEvents, cursor]);

  return (
    <div className="flex flex-col min-h-screen bg-gray-950 text-gray-100 font-mono">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-emerald-400 font-bold text-sm tracking-wide">emerge</span>
          <span className="text-gray-500 text-xs">dashboard</span>
          <span className="text-gray-600 text-xs">|</span>
          <span className="text-gray-400 text-xs">
            {eventCount} event{eventCount !== 1 ? "s" : ""}
          </span>
        </div>
        <StatusPill status={connectionStatus} />
      </header>

      {/* Main grid */}
      <main className="flex-1 grid grid-cols-2 grid-rows-2 gap-0 min-h-0">
        {/* Top-left: Topology */}
        <div className="border-r border-b border-gray-800 overflow-auto p-3">
          <TopologyGraph state={displayState} />
        </div>

        {/* Top-right: Verdict Explorer — the differentiator, prominent */}
        <div className="border-b border-gray-800 overflow-auto p-3">
          <VerdictExplorer state={displayState} />
        </div>

        {/* Bottom-left: Cost Chart */}
        <div className="border-r border-gray-800 overflow-auto p-3">
          <CostChart state={displayState} />
        </div>

        {/* Bottom-right: Trace Timeline */}
        <div className="overflow-auto p-3">
          <TraceTimeline state={displayState} />
        </div>
      </main>

      {/* Replay scrubber — only visible in replay mode */}
      {isReplayMode && (
        <footer className="border-t border-gray-800 bg-gray-900 shrink-0">
          <ReplayScrubber
            total={eventCount}
            cursor={cursor}
            playing={playing}
            speed={speed}
            onCursorChange={setCursor}
            onPlayPause={() => setPlaying((p) => !p)}
            onSpeedChange={setSpeed}
          />
        </footer>
      )}
    </div>
  );
}
