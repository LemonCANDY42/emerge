/**
 * VerdictExplorer tests.
 *
 * Asserts filter buttons work and verdict rows render correctly.
 *
 * @vitest-environment jsdom
 */

import { EMPTY_STATE } from "@lwrf42/emerge-tui/state";
import type { TuiState, VerdictEntry } from "@lwrf42/emerge-tui/state";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { VerdictExplorer } from "./VerdictExplorer.js";

function makeState(verdicts: readonly VerdictEntry[]): TuiState {
  return { ...EMPTY_STATE, verdicts };
}

const ALIGNED: VerdictEntry = {
  at: 1000,
  from: "adjudicator-1" as import("@lwrf42/emerge-kernel/contracts").AgentId,
  kind: "aligned",
  rationale: "All key tokens present",
};

const FAILED: VerdictEntry = {
  at: 2000,
  from: "adjudicator-1" as import("@lwrf42/emerge-kernel/contracts").AgentId,
  kind: "failed",
  rationale: "Critical requirement missing",
};

const PARTIAL: VerdictEntry = {
  at: 3000,
  from: "adjudicator-1" as import("@lwrf42/emerge-kernel/contracts").AgentId,
  kind: "partial",
  rationale: "Some tokens missing",
};

describe("VerdictExplorer", () => {
  afterEach(() => cleanup());

  it("renders 'No verdicts yet' when state has no verdicts", () => {
    render(<VerdictExplorer state={EMPTY_STATE} />);
    expect(screen.getByText(/no verdicts yet/i)).toBeDefined();
  });

  it("renders all verdicts by default", () => {
    const state = makeState([ALIGNED, FAILED, PARTIAL]);
    render(<VerdictExplorer state={state} />);
    expect(screen.getByText(/all \(3\)/i)).toBeDefined();
  });

  it("filter aligned shows only aligned verdicts", () => {
    const state = makeState([ALIGNED, FAILED, PARTIAL]);
    const { getAllByText } = render(<VerdictExplorer state={state} />);

    // Click the "Aligned (1)" filter button
    const alignedButtons = getAllByText(/aligned \(1\)/i);
    const alignedBtn = alignedButtons[0];
    if (!alignedBtn) throw new Error("Expected aligned filter button");
    fireEvent.click(alignedBtn);

    // Only aligned rationale should appear
    expect(screen.getByText(/all key tokens present/i)).toBeDefined();
  });

  it("filter misaligned shows failed verdicts", () => {
    const state = makeState([ALIGNED, FAILED, PARTIAL]);
    const { getAllByText } = render(<VerdictExplorer state={state} />);

    const misalignedButtons = getAllByText(/misaligned/i);
    const misalignedBtn = misalignedButtons[0];
    if (!misalignedBtn) throw new Error("Expected misaligned filter button");
    fireEvent.click(misalignedBtn);

    expect(screen.getByText(/critical requirement missing/i)).toBeDefined();
  });

  it("filter uncertain shows partial verdicts", () => {
    const state = makeState([ALIGNED, FAILED, PARTIAL]);
    const { getAllByText } = render(<VerdictExplorer state={state} />);

    const uncertainButtons = getAllByText(/uncertain/i);
    const uncertainBtn = uncertainButtons[0];
    if (!uncertainBtn) throw new Error("Expected uncertain filter button");
    fireEvent.click(uncertainBtn);

    expect(screen.getByText(/some tokens missing/i)).toBeDefined();
  });

  it("clicking a verdict row expands to show full rationale and agent", () => {
    const state = makeState([ALIGNED]);
    const { getAllByRole } = render(<VerdictExplorer state={state} />);

    // The verdict row has role=button (the filter buttons are also buttons).
    // Find the verdict row by aria-expanded attribute.
    const buttons = getAllByRole("button");
    // Filter rows have no aria-expanded; verdict rows do. Click the first one with aria-expanded.
    const verdictRow = buttons.find((b) => b.hasAttribute("aria-expanded"));
    expect(verdictRow).toBeDefined();
    if (!verdictRow) throw new Error("Expected verdict row with aria-expanded");
    fireEvent.click(verdictRow);

    // After expand, the full rationale + agent details appear
    expect(screen.getByText(/Agent: adjudicator-1/i)).toBeDefined();
    expect(screen.getByText(/Kind: aligned/i)).toBeDefined();
  });

  it("filter shows 'No verdicts match this filter' when empty", () => {
    const state = makeState([ALIGNED]);
    const { getAllByText } = render(<VerdictExplorer state={state} />);

    const misalignedBtns = getAllByText(/misaligned/i);
    const misalignedBtnFirst = misalignedBtns[0];
    if (!misalignedBtnFirst) throw new Error("Expected misaligned filter button");
    fireEvent.click(misalignedBtnFirst);

    expect(screen.getByText(/no verdicts match this filter/i)).toBeDefined();
  });
});
