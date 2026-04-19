/**
 * TopologyTree — renders the agent hierarchy as an ASCII tree.
 *
 * Builds the tree from AgentNode.parentId links in TuiState.agents.
 * Agents that appear in lifecycle events but never sent a handshake are
 * rooted under "(unknown parent)" rather than crashing.
 */

import type { AgentId } from "@lwrf42/emerge-kernel/contracts";
import { Box, Text } from "ink";
import type React from "react";
import type { AgentNode, TuiState } from "../state/types.js";

const STATE_BADGE: Record<string, string> = {
  idle: "[idle]",
  thinking: "[thinking]",
  calling_tool: "[tool]",
  waiting_for_message: "[waiting]",
  waiting_for_human: "[awaiting-human]",
  suspended: "[suspended]",
  completed: "[completed]",
  failed: "[failed]",
};

const STATE_COLOR: Record<string, string> = {
  idle: "gray",
  thinking: "blue",
  calling_tool: "blue",
  waiting_for_message: "yellow",
  waiting_for_human: "yellow",
  suspended: "yellow",
  completed: "cyan",
  failed: "red",
};

interface TreeNodeProps {
  readonly node: AgentNode;
  readonly allNodes: ReadonlyMap<AgentId, AgentNode>;
  readonly prefix: string;
  readonly isLast: boolean;
}

function getChildren(parentId: AgentId, allNodes: ReadonlyMap<AgentId, AgentNode>): AgentNode[] {
  const result: AgentNode[] = [];
  for (const n of allNodes.values()) {
    if (n.parentId === parentId) {
      result.push(n);
    }
  }
  return result;
}

function TreeNodeComponent({ node, allNodes, prefix, isLast }: TreeNodeProps): React.ReactElement {
  const nodeChildren = getChildren(node.id, allNodes);
  const connector = isLast ? "└─" : "├─";
  const badge = STATE_BADGE[node.state] ?? `[${node.state}]`;
  const colorStr: string = STATE_COLOR[node.state] ?? "white";

  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          {prefix}
          {connector} {String(node.id)}
        </Text>
        <Text> </Text>
        <Text color={colorStr}>{badge}</Text>
        {node.role !== undefined && <Text color="gray"> ({node.role})</Text>}
      </Box>
      {nodeChildren.map((child, idx) => {
        const childPrefix = prefix + (isLast ? "   " : "│  ");
        const childIsLast = idx === nodeChildren.length - 1;
        return (
          <TreeNodeComponent
            key={String(child.id)}
            node={child}
            allNodes={allNodes}
            prefix={childPrefix}
            isLast={childIsLast}
          />
        );
      })}
    </Box>
  );
}

interface TopologyTreeProps {
  readonly state: TuiState;
}

export function TopologyTree({ state }: TopologyTreeProps): React.ReactElement {
  const { agents } = state;

  // Find root nodes: parentId is undefined or points to a non-existent parent
  const roots: AgentNode[] = [];
  const unknownParentChildren: AgentNode[] = [];

  for (const node of agents.values()) {
    if (node.parentId === undefined) {
      roots.push(node);
    } else if (!agents.has(node.parentId)) {
      // Parent doesn't exist in the map — treat as unknown-parent child
      unknownParentChildren.push(node);
    }
  }

  if (agents.size === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          Topology
        </Text>
        <Text color="gray">(no agents spawned yet)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Topology
      </Text>
      {roots.map((root, idx) => (
        <TreeNodeComponent
          key={String(root.id)}
          node={root}
          allNodes={agents}
          prefix=""
          isLast={idx === roots.length - 1 && unknownParentChildren.length === 0}
        />
      ))}
      {unknownParentChildren.length > 0 && (
        <Box flexDirection="column">
          <Text color="gray">(unknown parent)</Text>
          {unknownParentChildren.map((node, idx) => (
            <TreeNodeComponent
              key={String(node.id)}
              node={node}
              allNodes={agents}
              prefix="  "
              isLast={idx === unknownParentChildren.length - 1}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}
