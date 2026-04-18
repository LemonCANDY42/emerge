/**
 * CycleGuard unit tests.
 *
 * Covers: recordToolCall fingerprints + threshold trip; recordProviderCall
 * fingerprints; window decay (oldest entry evicted beyond windowSize).
 */

import { describe, expect, it } from "vitest";
import type { AgentId } from "../contracts/index.js";
import { CycleGuard } from "./cycle-guard.js";

function id(s: string): AgentId {
  return s as AgentId;
}

describe("CycleGuard", () => {
  it("does not trip below repeatThreshold", () => {
    const guard = new CycleGuard(10, 3);
    const agent = id("a");
    guard.recordToolCall(agent, "bash", '{"cmd":"ls"}', "out");
    guard.recordToolCall(agent, "bash", '{"cmd":"ls"}', "out");
    expect(guard.shouldInterrupt(agent)).toBe(false);
  });

  it("trips when repeatThreshold is reached", () => {
    const guard = new CycleGuard(10, 3);
    const agent = id("a");
    for (let i = 0; i < 3; i++) {
      guard.recordToolCall(agent, "bash", '{"cmd":"ls"}', "out");
    }
    expect(guard.shouldInterrupt(agent)).toBe(true);
  });

  it("does not trip when calls differ", () => {
    const guard = new CycleGuard(10, 3);
    const agent = id("a");
    guard.recordToolCall(agent, "bash", '{"cmd":"ls"}', "out");
    guard.recordToolCall(agent, "bash", '{"cmd":"pwd"}', "out");
    guard.recordToolCall(agent, "bash", '{"cmd":"echo hi"}', "out");
    expect(guard.shouldInterrupt(agent)).toBe(false);
  });

  it("window evicts oldest — prevents stale fingerprints from tripping", () => {
    const windowSize = 4;
    const threshold = 3;
    const guard = new CycleGuard(windowSize, threshold);
    const agent = id("a");

    // Push 2 identical calls
    guard.recordToolCall(agent, "bash", '{"cmd":"ls"}', "out");
    guard.recordToolCall(agent, "bash", '{"cmd":"ls"}', "out");
    // Push 3 different calls — this evicts 1 "ls" from the window
    guard.recordToolCall(agent, "bash", '{"cmd":"a"}', "a");
    guard.recordToolCall(agent, "bash", '{"cmd":"b"}', "b");
    guard.recordToolCall(agent, "bash", '{"cmd":"c"}', "c");

    // Window now: [ls, a, b, c] — only 1 "ls" left, below threshold
    expect(guard.shouldInterrupt(agent)).toBe(false);
  });

  it("recordProviderCall fingerprints are tracked independently", () => {
    const guard = new CycleGuard(10, 2);
    const agent = id("a");
    guard.recordProviderCall(agent, "mock", "hash1");
    guard.recordProviderCall(agent, "mock", "hash1");
    expect(guard.shouldInterrupt(agent)).toBe(true);
  });

  it("reset clears window", () => {
    const guard = new CycleGuard(10, 2);
    const agent = id("a");
    guard.recordProviderCall(agent, "mock", "hash1");
    guard.recordProviderCall(agent, "mock", "hash1");
    expect(guard.shouldInterrupt(agent)).toBe(true);
    guard.reset(agent);
    expect(guard.shouldInterrupt(agent)).toBe(false);
  });

  it("different agents are isolated", () => {
    const guard = new CycleGuard(10, 2);
    const a = id("a");
    const b = id("b");
    guard.recordToolCall(a, "bash", '{"cmd":"ls"}', "out");
    guard.recordToolCall(a, "bash", '{"cmd":"ls"}', "out");
    expect(guard.shouldInterrupt(a)).toBe(true);
    expect(guard.shouldInterrupt(b)).toBe(false);
  });
});
