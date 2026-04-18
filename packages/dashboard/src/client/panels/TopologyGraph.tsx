/**
 * TopologyGraph — SVG-based DAG of agents.
 *
 * Design choice: pure SVG with depth-bucketed rows rather than reactflow.
 * Rationale: reactflow adds ~200KB gzipped and requires significant setup
 * for a read-only display. The agent topology is a shallow tree (typically
 * 2-3 levels) — a simple layered layout is both faster and smaller.
 * Document: see docs/adr/0039-dashboard-graph-pure-svg.md (if created).
 *
 * Layout algorithm:
 *   1. BFS from roots → assign depth level to each node.
 *   2. Lay out nodes in rows by depth, evenly spaced horizontally.
 *   3. Draw edges from parent center to child center.
 *
 * Node colors match TUI conventions:
 *   idle                → gray
 *   thinking/running    → green
 *   calling_tool        → blue
 *   waiting_*           → yellow
 *   completed           → teal/cyan
 *   failed              → red
 */

import type { AgentId } from "@emerge/kernel/contracts";
import type { AgentNode, TuiState } from "@emerge/tui/state";
import type React from "react";
import { useMemo } from "react";

interface TopologyGraphProps {
  readonly state: TuiState;
}

const STATE_COLOR: Record<string, string> = {
  idle: "#6b7280",
  running: "#22c55e",
  thinking: "#22c55e",
  calling_tool: "#3b82f6",
  waiting_for_message: "#eab308",
  waiting_for_human: "#f59e0b",
  suspended: "#a78bfa",
  completed: "#14b8a6",
  failed: "#ef4444",
};

const STATE_LABEL: Record<string, string> = {
  idle: "idle",
  running: "running",
  thinking: "thinking",
  calling_tool: "tool",
  waiting_for_message: "waiting",
  waiting_for_human: "awaiting-human",
  suspended: "suspended",
  completed: "done",
  failed: "failed",
};

const NODE_W = 120;
const NODE_H = 40;
const H_GAP = 40;
const V_GAP = 60;

interface LayoutNode {
  node: AgentNode;
  x: number;
  y: number;
}

function buildLayout(agents: ReadonlyMap<AgentId, AgentNode>): {
  nodes: LayoutNode[];
  edges: { x1: number; y1: number; x2: number; y2: number }[];
  width: number;
  height: number;
} {
  if (agents.size === 0) return { nodes: [], edges: [], width: 300, height: 100 };

  // Build adjacency
  const childrenOf = new Map<AgentId | undefined, AgentId[]>();
  for (const node of agents.values()) {
    const parentId = agents.has(node.parentId as AgentId) ? node.parentId : undefined;
    if (!childrenOf.has(parentId as AgentId | undefined)) {
      childrenOf.set(parentId as AgentId | undefined, []);
    }
    childrenOf.get(parentId as AgentId | undefined)?.push(node.id);
  }

  // BFS to assign depths
  const depth = new Map<AgentId, number>();
  const queue: { id: AgentId; d: number }[] = [];
  const roots = childrenOf.get(undefined) ?? [];
  for (const r of roots) queue.push({ id: r, d: 0 });

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    if (depth.has(item.id)) continue;
    depth.set(item.id, item.d);
    for (const child of childrenOf.get(item.id) ?? []) {
      queue.push({ id: child, d: item.d + 1 });
    }
  }

  // Any unvisited nodes (e.g. unknown parents) get depth 0
  for (const id of agents.keys()) {
    if (!depth.has(id)) depth.set(id, 0);
  }

  // Group by depth
  const byDepth = new Map<number, AgentId[]>();
  for (const [id, d] of depth) {
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)?.push(id);
  }

  const maxDepth = Math.max(...Array.from(depth.values()));
  const maxNodesInRow = Math.max(...Array.from(byDepth.values()).map((arr) => arr.length));

  const width = Math.max(300, maxNodesInRow * (NODE_W + H_GAP) + H_GAP);
  const height = (maxDepth + 1) * (NODE_H + V_GAP) + V_GAP;

  const posMap = new Map<AgentId, { x: number; y: number }>();

  for (const [d, ids] of byDepth) {
    const count = ids.length;
    const totalW = count * NODE_W + (count - 1) * H_GAP;
    const startX = (width - totalW) / 2;
    const y = V_GAP + d * (NODE_H + V_GAP);
    ids.forEach((id, i) => {
      posMap.set(id, { x: startX + i * (NODE_W + H_GAP), y });
    });
  }

  const layoutNodes: LayoutNode[] = [];
  for (const node of agents.values()) {
    const pos = posMap.get(node.id) ?? { x: 0, y: 0 };
    layoutNodes.push({ node, x: pos.x, y: pos.y });
  }

  const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const node of agents.values()) {
    if (node.parentId !== undefined && agents.has(node.parentId)) {
      const parentPos = posMap.get(node.parentId);
      const childPos = posMap.get(node.id);
      if (parentPos && childPos) {
        edges.push({
          x1: parentPos.x + NODE_W / 2,
          y1: parentPos.y + NODE_H,
          x2: childPos.x + NODE_W / 2,
          y2: childPos.y,
        });
      }
    }
  }

  return { nodes: layoutNodes, edges, width, height };
}

export function TopologyGraph({ state }: TopologyGraphProps): React.ReactElement {
  const layout = useMemo(() => buildLayout(state.agents), [state.agents]);

  if (state.agents.size === 0) {
    return (
      <div className="h-full flex flex-col">
        <h2 className="text-xs font-bold text-cyan-400 uppercase tracking-wider mb-2">Topology</h2>
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          No agents spawned yet
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <h2 className="text-xs font-bold text-cyan-400 uppercase tracking-wider mb-2">Topology</h2>
      <div className="flex-1 overflow-auto">
        <svg
          width={layout.width}
          height={layout.height}
          className="block"
          role="img"
          aria-label="Agent topology graph"
        >
          <title>Agent topology graph</title>
          {/* Edges */}
          {layout.edges.map((e, i) => (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: edges have no stable id
              key={i}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke="#374151"
              strokeWidth={1.5}
              markerEnd="url(#arrow)"
            />
          ))}

          {/* Arrow marker */}
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="#374151" />
            </marker>
          </defs>

          {/* Nodes */}
          {layout.nodes.map(({ node, x, y }) => {
            const color = STATE_COLOR[node.state] ?? "#6b7280";
            const label = STATE_LABEL[node.state] ?? node.state;
            const idStr = String(node.id);
            const displayId = idStr.length > 14 ? `${idStr.slice(0, 13)}\u2026` : idStr;

            return (
              <g key={idStr} transform={`translate(${x}, ${y})`}>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill="#111827"
                  stroke={color}
                  strokeWidth={1.5}
                />
                <text
                  x={NODE_W / 2}
                  y={14}
                  textAnchor="middle"
                  fill="#e5e7eb"
                  fontSize={10}
                  fontFamily="monospace"
                >
                  {displayId}
                </text>
                {node.role && (
                  <text
                    x={NODE_W / 2}
                    y={24}
                    textAnchor="middle"
                    fill="#6b7280"
                    fontSize={9}
                    fontFamily="monospace"
                  >
                    {node.role}
                  </text>
                )}
                <text
                  x={NODE_W / 2}
                  y={35}
                  textAnchor="middle"
                  fill={color}
                  fontSize={9}
                  fontFamily="monospace"
                >
                  [{label}]
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
