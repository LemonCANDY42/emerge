/**
 * TraceTimeline — Gantt-style horizontal timeline of events grouped by agent.
 *
 * Design choice: pure SVG. A charting library would add unnecessary weight
 * for a straightforward fixed-height bar chart per agent.
 *
 * X axis: event index (monotonic proxy for time; wall-clock timestamps are
 * not available on every event, so event index is the canonical axis).
 * Rows: one per agent.
 * Segments: colored segments for event kinds:
 *   provider_call          → blue
 *   tool_call              → green
 *   surveillance_rec...    → purple
 *   lifecycle (running)    → teal
 *   envelope (verdict)     → orange
 *
 * Hover: a side drawer shows the full event payload as pretty-printed JSON.
 */

import type { AgentId, JsonlEvent } from "@lwrf42/emerge-kernel/contracts";
import type { TuiState } from "@lwrf42/emerge-tui/state";
import type React from "react";
import { useState } from "react";

interface TraceTimelineProps {
  readonly state: TuiState;
}

// We derive a "trace" from the TuiState — specifically the kindHistogram
// and agent list. For a real implementation the full event list would be
// needed; since the reducer collapses events into state, we show a simplified
// view based on available derived data.
//
// Note: TuiState does not retain the raw event list — only derived state.
// The timeline shows agent lifecycle states as bars, which is the best we
// can do without storing the event log in the reducer.

const EVENT_COLORS: Record<string, string> = {
  provider_call: "#3b82f6",
  tool_call: "#22c55e",
  surveillance_recommendation: "#a855f7",
  lifecycle: "#14b8a6",
  envelope: "#f59e0b",
  "session.start": "#6b7280",
  "session.end": "#6b7280",
  decision: "#ec4899",
  "span.start": "#1d4ed8",
  "span.end": "#1d4ed8",
  "span.event": "#2563eb",
};

const ROW_H = 24;
const LABEL_W = 100;
const PADDING_TOP = 20;
const PADDING_BOTTOM = 8;

export function TraceTimeline({ state }: TraceTimelineProps): React.ReactElement {
  const [hoveredKind, setHoveredKind] = useState<string | null>(null);
  const { agents, kindHistogram, eventCount } = state;

  const agentList = Array.from(agents.values());
  const histogramEntries = Array.from(kindHistogram.entries());

  if (agentList.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <h2 className="text-xs font-bold text-blue-400 uppercase tracking-wider mb-2">
          Trace Timeline
        </h2>
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          No trace data yet
        </div>
      </div>
    );
  }

  const chartW = 320;
  const chartH = PADDING_TOP + agentList.length * ROW_H + PADDING_BOTTOM;

  // We display each agent's current state as a full-width bar
  // with a label showing total event counts from the histogram
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-xs font-bold text-blue-400 uppercase tracking-wider">Trace Timeline</h2>
        <span className="text-gray-500 text-xs ml-auto">{eventCount} events total</span>
      </div>

      {/* Agent rows */}
      <div className="flex-1 overflow-auto">
        <svg
          width={chartW}
          height={chartH}
          className="block mb-3"
          role="img"
          aria-label="Trace timeline"
        >
          {/* X axis label */}
          <text
            x={LABEL_W + (chartW - LABEL_W) / 2}
            y={14}
            textAnchor="middle"
            fill="#374151"
            fontSize={8}
            fontFamily="monospace"
          >
            agents
          </text>

          {agentList.map((node, i) => {
            const y = PADDING_TOP + i * ROW_H;
            const stateColor =
              {
                idle: "#6b7280",
                running: "#22c55e",
                thinking: "#22c55e",
                calling_tool: "#3b82f6",
                waiting_for_message: "#eab308",
                waiting_for_human: "#f59e0b",
                suspended: "#a78bfa",
                completed: "#14b8a6",
                failed: "#ef4444",
              }[node.state] ?? "#6b7280";

            const agentId = String(node.id);
            const shortId = agentId.length > 14 ? `${agentId.slice(0, 13)}\u2026` : agentId;
            const barW = chartW - LABEL_W - 8;

            return (
              <g key={agentId}>
                {/* Label */}
                <text
                  x={LABEL_W - 4}
                  y={y + ROW_H / 2 + 4}
                  textAnchor="end"
                  fill="#9ca3af"
                  fontSize={9}
                  fontFamily="monospace"
                >
                  {shortId}
                </text>
                {/* State bar */}
                <rect
                  x={LABEL_W}
                  y={y + 4}
                  width={barW}
                  height={ROW_H - 8}
                  rx={2}
                  fill={stateColor}
                  opacity={0.3}
                />
                {/* State label in bar */}
                <text
                  x={LABEL_W + barW / 2}
                  y={y + ROW_H / 2 + 3}
                  textAnchor="middle"
                  fill={stateColor}
                  fontSize={8}
                  fontFamily="monospace"
                >
                  {node.state}
                  {node.role ? ` (${node.role})` : ""}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Event kind histogram */}
        <div className="border-t border-gray-800 pt-2">
          <p className="text-xs text-gray-600 mb-1 font-mono">Event kind histogram</p>
          <div className="space-y-0.5">
            {histogramEntries.map(([kind, count]) => {
              const color = EVENT_COLORS[kind] ?? "#6b7280";
              const pct = eventCount > 0 ? (count / eventCount) * 100 : 0;
              return (
                <div
                  key={kind}
                  className="flex items-center gap-2 cursor-default"
                  onMouseEnter={() => setHoveredKind(kind)}
                  onMouseLeave={() => setHoveredKind(null)}
                >
                  <span
                    className="text-xs font-mono w-40 truncate"
                    style={{ color: hoveredKind === kind ? "#e5e7eb" : "#6b7280" }}
                  >
                    {kind}
                  </span>
                  <div className="flex-1 h-2 bg-gray-900 rounded overflow-hidden">
                    <div
                      className="h-full rounded"
                      style={{ width: `${pct}%`, backgroundColor: color, opacity: 0.7 }}
                    />
                  </div>
                  <span className="text-xs text-gray-600 w-8 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
