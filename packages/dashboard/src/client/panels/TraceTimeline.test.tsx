/**
 * TraceTimeline tests.
 *
 * Asserts agent rows and histogram entries render correctly.
 *
 * @vitest-environment jsdom
 */

import type { AgentId } from "@emerge/kernel/contracts";
import { EMPTY_STATE } from "@emerge/tui/state";
import type { AgentNode, TuiState } from "@emerge/tui/state";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TraceTimeline } from "./TraceTimeline.js";

function makeState(agents: AgentNode[], histogram: [string, number][] = []): TuiState {
  const agentMap = new Map<AgentId, AgentNode>();
  for (const a of agents) agentMap.set(a.id, a);
  const kindHistogram = new Map<string, number>(histogram);
  const eventCount = histogram.reduce((s, [, v]) => s + v, 0);
  return { ...EMPTY_STATE, agents: agentMap, kindHistogram, eventCount };
}

describe("TraceTimeline", () => {
  afterEach(() => cleanup());

  it("shows empty state message when no agents", () => {
    render(<TraceTimeline state={EMPTY_STATE} />);
    expect(screen.getByText(/no trace data yet/i)).toBeDefined();
  });

  it("renders one row per agent", () => {
    const state = makeState([
      { id: "sup" as AgentId, parentId: undefined, state: "completed", role: "supervisor" },
      { id: "wrk" as AgentId, parentId: "sup" as AgentId, state: "running", role: "worker" },
    ]);
    const { container } = render(<TraceTimeline state={state} />);

    const texts = Array.from(container.querySelectorAll("svg text")).map(
      (el) => el.textContent ?? "",
    );
    expect(texts.some((t) => t.includes("sup"))).toBe(true);
    expect(texts.some((t) => t.includes("wrk"))).toBe(true);
  });

  it("renders histogram entries", () => {
    const state = makeState(
      [{ id: "a" as AgentId, parentId: undefined, state: "idle", role: "agent" }],
      [
        ["provider_call", 3],
        ["lifecycle", 5],
      ],
    );
    render(<TraceTimeline state={state} />);

    expect(screen.getByText("provider_call")).toBeDefined();
    expect(screen.getByText("lifecycle")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("5")).toBeDefined();
  });

  it("displays total event count in header", () => {
    const state = makeState(
      [{ id: "a" as AgentId, parentId: undefined, state: "idle", role: "agent" }],
      [["lifecycle", 7]],
    );
    render(<TraceTimeline state={state} />);
    expect(screen.getByText(/7 events total/i)).toBeDefined();
  });
});
