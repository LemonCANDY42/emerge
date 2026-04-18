/**
 * ReplayScrubber tests.
 *
 * Asserts play/pause, step, speed controls, and the slider work.
 *
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayScrubber } from "./ReplayScrubber.js";

function renderScrubber(overrides: Partial<React.ComponentProps<typeof ReplayScrubber>> = {}) {
  const defaults = {
    total: 100,
    cursor: 0,
    playing: false,
    speed: 1 as const,
    onCursorChange: vi.fn(),
    onPlayPause: vi.fn(),
    onSpeedChange: vi.fn(),
  };
  const props = { ...defaults, ...overrides };
  // Use a fresh container each time to avoid cross-test DOM pollution
  const container = document.createElement("div");
  document.body.appendChild(container);
  const result = render(<ReplayScrubber {...props} />, { container });
  return { ...result, props };
}

describe("ReplayScrubber", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders play button when not playing", () => {
    const { container } = renderScrubber({ playing: false });
    const playBtn = container.querySelector('[aria-label="Play"]');
    expect(playBtn).toBeDefined();
    expect(playBtn).not.toBeNull();
  });

  it("renders pause button when playing", () => {
    const { container } = renderScrubber({ playing: true });
    const pauseBtn = container.querySelector('[aria-label="Pause"]');
    expect(pauseBtn).toBeDefined();
    expect(pauseBtn).not.toBeNull();
  });

  it("clicking play/pause button calls onPlayPause", () => {
    const { container, props } = renderScrubber({ playing: false });
    const playBtn = container.querySelector('[aria-label="Play"]') as HTMLElement;
    fireEvent.click(playBtn);
    expect(props.onPlayPause).toHaveBeenCalledOnce();
  });

  it("step forward calls onCursorChange with cursor + 1", () => {
    const { container, props } = renderScrubber({ cursor: 5 });
    const fwdBtn = container.querySelector('[aria-label="Step forward"]') as HTMLElement;
    fireEvent.click(fwdBtn);
    expect(props.onCursorChange).toHaveBeenCalledWith(6);
  });

  it("step back calls onCursorChange with cursor - 1", () => {
    const { container, props } = renderScrubber({ cursor: 5 });
    const backBtn = container.querySelector('[aria-label="Step back"]') as HTMLElement;
    fireEvent.click(backBtn);
    expect(props.onCursorChange).toHaveBeenCalledWith(4);
  });

  it("step back is disabled at cursor 0", () => {
    const { container } = renderScrubber({ cursor: 0 });
    const stepBack = container.querySelector('[aria-label="Step back"]') as HTMLButtonElement;
    expect(stepBack.disabled).toBe(true);
  });

  it("step forward is disabled at cursor === total", () => {
    const { container } = renderScrubber({ cursor: 100, total: 100 });
    const stepFwd = container.querySelector('[aria-label="Step forward"]') as HTMLButtonElement;
    expect(stepFwd.disabled).toBe(true);
  });

  it("speed buttons trigger onSpeedChange with correct value", () => {
    const { container, props } = renderScrubber({ speed: 1 });
    const speed2Btn = container.querySelector('[aria-label="Speed 2x"]') as HTMLElement;
    const speed4Btn = container.querySelector('[aria-label="Speed 4x"]') as HTMLElement;
    fireEvent.click(speed2Btn);
    expect(props.onSpeedChange).toHaveBeenCalledWith(2);
    fireEvent.click(speed4Btn);
    expect(props.onSpeedChange).toHaveBeenCalledWith(4);
  });

  it("active speed button has purple styling", () => {
    const { container } = renderScrubber({ speed: 2 });
    const speed2Btn = container.querySelector('[aria-label="Speed 2x"]') as HTMLElement;
    expect(speed2Btn.className).toContain("bg-purple");

    const speed1Btn = container.querySelector('[aria-label="Speed 1x"]') as HTMLElement;
    expect(speed1Btn.className).not.toContain("bg-purple");
  });

  it("slider change calls onCursorChange", () => {
    const { container, props } = renderScrubber({ cursor: 10, total: 100 });
    const slider = container.querySelector('[aria-label="Event cursor"]') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "50" } });
    expect(props.onCursorChange).toHaveBeenCalledWith(50);
  });

  it("displays cursor/total label", () => {
    const { container } = renderScrubber({ cursor: 42, total: 200 });
    expect(container.textContent).toContain("42 / 200");
  });
});
