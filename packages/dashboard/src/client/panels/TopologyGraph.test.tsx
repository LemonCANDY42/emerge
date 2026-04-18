/**
 * TopologyGraph tests.
 *
 * Asserts nodes are rendered for each agent in the state.
 *
 * @vitest-environment jsdom
 */

import type { AgentId } from "@emerge/kernel/contracts";
import { EMPTY_STATE } from "@emerge/tui/state";
import type { AgentNode, TuiState } from "@emerge/tui/state";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TopologyGraph } from "./TopologyGraph.js";

function makeState(agents: AgentNode[]): TuiState {
  const map = new Map<AgentId, AgentNode>();
  for (const a of agents) map.set(a.id, a);
  return { ...EMPTY_STATE, agents: map };
}

describe("TopologyGraph", () => {
  afterEach(() => cleanup());

  it("renders empty state message when no agents", () => {
    render(<TopologyGraph state={EMPTY_STATE} />);
    expect(screen.getByText(/no agents spawned yet/i)).toBeDefined();
  });

  it("renders a node for each agent", () => {
    const state = makeState([
      {
        id: "supervisor-1" as AgentId,
        parentId: undefined,
        state: "completed",
        role: "supervisor",
      },
      {
        id: "worker-a" as AgentId,
        parentId: "supervisor-1" as AgentId,
        state: "completed",
        role: "worker",
      },
      {
        id: "worker-b" as AgentId,
        parentId: "supervisor-1" as AgentId,
        state: "running",
        role: "worker",
      },
    ]);
    const { container } = render(<TopologyGraph state={state} />);

    // Each agent should have a text element in the SVG
    const svgTexts = container.querySelectorAll("svg text");
    const ids = Array.from(svgTexts).map((el) => el.textContent ?? "");

    expect(ids.some((t) => t.includes("supervisor-1"))).toBe(true);
    expect(ids.some((t) => t.includes("worker-a"))).toBe(true);
    expect(ids.some((t) => t.includes("worker-b"))).toBe(true);
  });

  it("renders edges between parent and child nodes", () => {
    const state = makeState([
      { id: "root" as AgentId, parentId: undefined, state: "completed", role: "supervisor" },
      { id: "child" as AgentId, parentId: "root" as AgentId, state: "running", role: "worker" },
    ]);
    const { container } = render(<TopologyGraph state={state} />);

    // One edge line should exist
    const lines = container.querySelectorAll("line");
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it("renders role label for agents that have a role", () => {
    const state = makeState([
      { id: "cust" as AgentId, parentId: undefined, state: "idle", role: "custodian" },
    ]);
    const { container } = render(<TopologyGraph state={state} />);
    const texts = Array.from(container.querySelectorAll("svg text")).map(
      (el) => el.textContent ?? "",
    );
    expect(texts.some((t) => t.includes("custodian"))).toBe(true);
  });
});
