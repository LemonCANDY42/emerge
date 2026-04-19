/**
 * CostChart — cumulative USD per agent over time, drawn in pure SVG.
 *
 * Design choice: pure SVG rather than recharts.
 * Rationale: the chart is a simple multi-line plot with two Y axes (tokens +
 * USD). Adding recharts for this would add ~130KB gzipped. Pure SVG keeps the
 * bundle small and the rendering predictable without a charting library's
 * abstraction layer. This matches the "SVG over recharts if charts are simple"
 * guidance in the spec.
 *
 * X axis: event index (proxy for time — real timestamps may compress oddly)
 * Y axis left: cumulative tokens (in + out)
 * Y axis right: cumulative USD
 *
 * Each agent gets its own line in a distinct color.
 */

import type { TuiState } from "@lwrf42/emerge-tui/state";
import type React from "react";
import { useMemo } from "react";

interface CostChartProps {
  readonly state: TuiState;
}

// Distinct colors for up to 8 agents (cycling after that)
const LINE_COLORS = [
  "#22c55e", // green
  "#3b82f6", // blue
  "#a855f7", // purple
  "#f59e0b", // amber
  "#14b8a6", // teal
  "#ef4444", // red
  "#ec4899", // pink
  "#84cc16", // lime
];

const CHART_W = 320;
const CHART_H = 140;
const PADDING = { top: 16, right: 56, bottom: 28, left: 56 };

function formatUsd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.0001) return `$${v.toExponential(1)}`;
  return `$${v.toFixed(v < 0.01 ? 4 : v < 1 ? 3 : 2)}`;
}

function formatTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

export function CostChart({ state }: CostChartProps): React.ReactElement {
  const { usage } = state;

  const agents = useMemo(() => Array.from(usage.values()), [usage]);

  const totalUsd = state.totalUsd;
  const totalTokens = useMemo(
    () => agents.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0),
    [agents],
  );

  if (agents.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <h2 className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-2">
          Cost / Tokens
        </h2>
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          No usage data yet
        </div>
      </div>
    );
  }

  const plotW = CHART_W - PADDING.left - PADDING.right;
  const plotH = CHART_H - PADDING.top - PADDING.bottom;

  // One data point per agent — bar-style (vertical lines from x-axis)
  const maxUsd = Math.max(...agents.map((a) => a.usd), 0.000001);
  const maxTokens = Math.max(...agents.map((a) => a.tokensIn + a.tokensOut), 1);

  const barW = Math.min(30, plotW / (agents.length + 1));
  const barGap = plotW / (agents.length + 1);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-xs font-bold text-amber-400 uppercase tracking-wider">Cost / Tokens</h2>
        <span className="text-gray-500 text-xs ml-auto">
          Total: {formatUsd(totalUsd)} / {formatTokens(totalTokens)} tok
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        <svg
          width={CHART_W}
          height={CHART_H}
          className="block"
          role="img"
          aria-label="Cost per agent bar chart"
        >
          {/* Background grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
            const y = PADDING.top + plotH - frac * plotH;
            return (
              <line
                key={frac}
                x1={PADDING.left}
                y1={y}
                x2={PADDING.left + plotW}
                y2={y}
                stroke="#1f2937"
                strokeWidth={1}
              />
            );
          })}

          {/* Left Y axis label (USD) */}
          <text
            x={PADDING.left - 4}
            y={PADDING.top}
            textAnchor="end"
            fill="#6b7280"
            fontSize={8}
            fontFamily="monospace"
          >
            {formatUsd(maxUsd)}
          </text>
          <text
            x={PADDING.left - 4}
            y={PADDING.top + plotH}
            textAnchor="end"
            fill="#6b7280"
            fontSize={8}
            fontFamily="monospace"
          >
            $0
          </text>
          <text
            x={8}
            y={PADDING.top + plotH / 2}
            textAnchor="middle"
            fill="#6b7280"
            fontSize={8}
            fontFamily="monospace"
            transform={`rotate(-90, 8, ${PADDING.top + plotH / 2})`}
          >
            USD
          </text>

          {/* Right Y axis label (tokens) */}
          <text
            x={PADDING.left + plotW + 4}
            y={PADDING.top}
            textAnchor="start"
            fill="#6b7280"
            fontSize={8}
            fontFamily="monospace"
          >
            {formatTokens(maxTokens)}
          </text>
          <text
            x={PADDING.left + plotW + 4}
            y={PADDING.top + plotH}
            textAnchor="start"
            fill="#6b7280"
            fontSize={8}
            fontFamily="monospace"
          >
            0
          </text>
          <text
            x={CHART_W - 6}
            y={PADDING.top + plotH / 2}
            textAnchor="middle"
            fill="#6b7280"
            fontSize={8}
            fontFamily="monospace"
            transform={`rotate(90, ${CHART_W - 6}, ${PADDING.top + plotH / 2})`}
          >
            tok
          </text>

          {/* Bars — USD (solid) + token outline overlay */}
          {agents.map((agent, i) => {
            const color = LINE_COLORS[i % LINE_COLORS.length] ?? "#6b7280";
            const cx = PADDING.left + barGap * (i + 1);
            const barH = (agent.usd / maxUsd) * plotH;
            const tokH = ((agent.tokensIn + agent.tokensOut) / maxTokens) * plotH;
            const baseY = PADDING.top + plotH;
            const agentId = String(agent.agentId);
            const shortId = agentId.length > 10 ? `${agentId.slice(0, 9)}\u2026` : agentId;

            return (
              <g key={agentId}>
                {/* USD bar (solid) */}
                <rect
                  x={cx - barW / 2}
                  y={baseY - barH}
                  width={barW}
                  height={barH}
                  fill={color}
                  opacity={0.7}
                />
                {/* Token outline bar */}
                <rect
                  x={cx - barW / 2}
                  y={baseY - tokH}
                  width={barW}
                  height={tokH}
                  fill="none"
                  stroke={color}
                  strokeWidth={1}
                  opacity={0.4}
                />
                {/* Agent label */}
                <text
                  x={cx}
                  y={baseY + 10}
                  textAnchor="middle"
                  fill="#6b7280"
                  fontSize={7}
                  fontFamily="monospace"
                >
                  {shortId}
                </text>
              </g>
            );
          })}

          {/* X axis */}
          <line
            x1={PADDING.left}
            y1={PADDING.top + plotH}
            x2={PADDING.left + plotW}
            y2={PADDING.top + plotH}
            stroke="#374151"
            strokeWidth={1}
          />
          {/* Y axis */}
          <line
            x1={PADDING.left}
            y1={PADDING.top}
            x2={PADDING.left}
            y2={PADDING.top + plotH}
            stroke="#374151"
            strokeWidth={1}
          />
        </svg>

        {/* Legend */}
        <div className="flex flex-wrap gap-2 mt-1">
          {agents.map((agent, i) => {
            const color = LINE_COLORS[i % LINE_COLORS.length] ?? "#6b7280";
            return (
              <span
                key={String(agent.agentId)}
                className="flex items-center gap-1 text-xs text-gray-400"
              >
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{ backgroundColor: color }}
                />
                {String(agent.agentId)}: {formatUsd(agent.usd)}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
