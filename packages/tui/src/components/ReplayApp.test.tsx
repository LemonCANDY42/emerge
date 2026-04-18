/**
 * ReplayApp state machine tests.
 *
 * Tests keyboard navigation and scrubber state transitions.
 * Uses ink-testing-library to simulate user input.
 *
 * State machine under test:
 *   cursor: 0..N (inclusive; 0 = before first event, N = after last)
 *   playing: boolean
 *
 * Transitions:
 *   → / rightArrow  : cursor += 1 (clamped), playing = false
 *   ← / leftArrow   : cursor -= 1 (clamped), playing = false
 *   ↓ / downArrow   : cursor += 10 (clamped), playing = false
 *   ↑ / upArrow     : cursor -= 10 (clamped), playing = false
 *   space           : playing = !playing
 *   q               : exit
 */

import type { AgentId, SessionId } from "@emerge/kernel/contracts";
import { JSONL_SCHEMA_VERSION, type JsonlEvent } from "@emerge/kernel/contracts";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { ReplayApp } from "./ReplayApp.js";

const SESSION_ID = "sess-replay" as SessionId;
const AGENT_A = "agent-replay-a" as AgentId;

function makeLifecycle(agent: AgentId, transition: string, at = Date.now()): JsonlEvent {
  return {
    v: JSONL_SCHEMA_VERSION,
    type: "lifecycle",
    at,
    agent,
    transition: transition as import("@emerge/kernel/contracts").AgentState,
  };
}

// Build a sequence of N events for scrubber testing
function makeEvents(n: number): JsonlEvent[] {
  return Array.from({ length: n }, (_, i) =>
    makeLifecycle(AGENT_A, i % 2 === 0 ? "thinking" : "idle", 1_700_000_000_000 + i * 100),
  );
}

// Escape codes for arrow keys (ANSI sequences)
const ARROW_RIGHT = "\u001B[C";
const ARROW_LEFT = "\u001B[D";
const ARROW_DOWN = "\u001B[B";
const ARROW_UP = "\u001B[A";

// Helper: wait for React to flush state updates in debug mode
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 10));
}

describe("ReplayApp scrubber state machine", () => {
  it("starts at event 0 / total N, paused", async () => {
    const events = makeEvents(5);
    const { lastFrame } = render(React.createElement(ReplayApp, { events }));
    await tick();
    const frame = lastFrame() ?? "";

    // Status bar should show "event 0 / 5"
    expect(frame).toContain("0 / 5");
    // Should show paused indicator
    expect(frame).toContain("⏸");
  });

  it("→ (right arrow) advances cursor by 1", async () => {
    const events = makeEvents(5);
    const { lastFrame, stdin } = render(React.createElement(ReplayApp, { events }));
    await tick();

    stdin.write(ARROW_RIGHT);
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 / 5");
  });

  it("← (left arrow) decrements cursor by 1 (clamped at 0)", async () => {
    const events = makeEvents(5);
    const { lastFrame, stdin } = render(React.createElement(ReplayApp, { events }));
    await tick();

    // First go to 2
    stdin.write(ARROW_RIGHT);
    await tick();
    stdin.write(ARROW_RIGHT);
    await tick();
    // Then go back to 1
    stdin.write(ARROW_LEFT);
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 / 5");
  });

  it("← at cursor=0 stays at 0 (clamp)", async () => {
    const events = makeEvents(5);
    const { lastFrame, stdin } = render(React.createElement(ReplayApp, { events }));
    await tick();

    stdin.write(ARROW_LEFT);
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("0 / 5");
  });

  it("↓ (down arrow) advances cursor by 10", async () => {
    const events = makeEvents(25);
    const { lastFrame, stdin } = render(React.createElement(ReplayApp, { events }));
    await tick();

    stdin.write(ARROW_DOWN);
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("10 / 25");
  });

  it("↑ (up arrow) decrements cursor by 10", async () => {
    const events = makeEvents(25);
    const { lastFrame, stdin } = render(React.createElement(ReplayApp, { events }));
    await tick();

    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ARROW_UP);
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("10 / 25");
  });

  it("↓ clamped at events.length", async () => {
    const events = makeEvents(5);
    const { lastFrame, stdin } = render(React.createElement(ReplayApp, { events }));
    await tick();

    stdin.write(ARROW_DOWN); // would be 10 but max is 5
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("5 / 5");
  });

  it("space toggles play/pause", async () => {
    const events = makeEvents(20);
    const { lastFrame, stdin } = render(React.createElement(ReplayApp, { events }));
    await tick();

    // Initially paused (⏸)
    expect(lastFrame()).toContain("⏸");

    // Press space → playing (▶)
    stdin.write(" ");
    await tick();
    expect(lastFrame()).toContain("▶");

    // Press space again → paused
    stdin.write(" ");
    await tick();
    expect(lastFrame()).toContain("⏸");
  });

  it("→ pauses if playing", async () => {
    const events = makeEvents(20);
    const { lastFrame, stdin } = render(React.createElement(ReplayApp, { events }));
    await tick();

    // Start playing
    stdin.write(" ");
    await tick();
    expect(lastFrame()).toContain("▶");

    // Right arrow should pause
    stdin.write(ARROW_RIGHT);
    await tick();
    expect(lastFrame()).toContain("⏸");
  });

  it("current kind appears in status bar", async () => {
    const events = makeEvents(3);
    const { lastFrame, stdin } = render(React.createElement(ReplayApp, { events }));
    await tick();

    // cursor=0: no event shown, kind=(none)
    expect(lastFrame()).toContain("(none)");

    // Move to event 1 — kind should start with "lifecycl" (may be truncated at 100 cols)
    stdin.write(ARROW_RIGHT);
    await tick();
    expect(lastFrame()).toContain("lifecycl");
  });

  it("shows replay controls hint in status bar", async () => {
    const events = makeEvents(3);
    const { lastFrame } = render(React.createElement(ReplayApp, { events }));
    await tick();
    // Status bar should mention controls
    expect(lastFrame()).toContain("←/→");
    expect(lastFrame()).toContain("space");
  });
});
