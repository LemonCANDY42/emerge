/**
 * Tests for makeRecorder() — verifies M3c2 finding #1 (JSONL line-ordering).
 *
 * The critical invariant: start() followed immediately by record() must produce
 * a file where:
 *   1. session.start is on line 1.
 *   2. The recorded event is on line 2.
 *   3. session.start.at <= recorded event.at.
 *
 * Previously, fire-and-forget async writes caused non-deterministic ordering.
 * The fix uses synchronous appendFileSync so order is always preserved.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContractId, SessionId } from "@lwrf42/emerge-kernel/contracts";
import type { JsonlEvent } from "@lwrf42/emerge-kernel/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRecorder } from "./index.js";

function tmpFile(): string {
  return path.join(
    os.tmpdir(),
    `emerge-recorder-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

function readJsonlLines(filePath: string): JsonlEvent[] {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as JsonlEvent);
}

describe("makeRecorder — JSONL line ordering (M3c2 finding #1)", () => {
  const filesToCleanup: string[] = [];

  beforeEach(() => {
    filesToCleanup.length = 0;
  });

  afterEach(() => {
    for (const f of filesToCleanup) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  });

  it("session.start appears on line 1 and recorded event on line 2", async () => {
    const fp = tmpFile();
    filesToCleanup.push(fp);

    const recorder = makeRecorder({ filePath: fp });
    const sessionId = "test-sess-order" as SessionId;
    const contractId = "test-contract" as ContractId;

    recorder.start(sessionId, contractId);
    recorder.record({
      kind: "lifecycle",
      at: Date.now(),
      agent: "test-agent" as never,
      transition: "idle",
    });

    const lines = readJsonlLines(fp);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]?.type).toBe("session.start");
    expect(lines[1]?.type).toBe("lifecycle");
  });

  it("session.start.at <= recorded event.at (timestamps captured at call site)", async () => {
    const fp = tmpFile();
    filesToCleanup.push(fp);

    const recorder = makeRecorder({ filePath: fp });
    const sessionId = "test-sess-ts" as SessionId;
    const contractId = "test-contract" as ContractId;

    recorder.start(sessionId, contractId);
    // Record an event with a timestamp guaranteed to be >= now
    const eventAt = Date.now();
    recorder.record({
      kind: "lifecycle",
      at: eventAt,
      agent: "test-agent" as never,
      transition: "idle",
    });

    const lines = readJsonlLines(fp);
    const startLine = lines[0];
    const eventLine = lines[1];

    expect(startLine?.type).toBe("session.start");
    expect(eventLine?.type).toBe("lifecycle");

    // The session.start timestamp must be <= the lifecycle event timestamp.
    // (start() is called before record(), so start.at <= event.at)
    if (startLine?.type === "session.start" && eventLine?.type === "lifecycle") {
      expect(startLine.at).toBeLessThanOrEqual(eventLine.at);
    }
  });

  it("session.end appears after all events", async () => {
    const fp = tmpFile();
    filesToCleanup.push(fp);

    const recorder = makeRecorder({ filePath: fp });
    const sessionId = "test-sess-end" as SessionId;
    const contractId = "test-contract" as ContractId;

    recorder.start(sessionId, contractId);
    recorder.record({
      kind: "lifecycle",
      at: Date.now(),
      agent: "test-agent" as never,
      transition: "idle",
    });
    await recorder.end(sessionId);

    const lines = readJsonlLines(fp);
    expect(lines.length).toBe(3);
    expect(lines[0]?.type).toBe("session.start");
    expect(lines[1]?.type).toBe("lifecycle");
    expect(lines[2]?.type).toBe("session.end");
  });

  it("multiple records maintain insertion order", async () => {
    const fp = tmpFile();
    filesToCleanup.push(fp);

    const recorder = makeRecorder({ filePath: fp });
    const sessionId = "test-sess-multi" as SessionId;
    const contractId = "test-contract" as ContractId;

    recorder.start(sessionId, contractId);
    const states: Array<
      | "idle"
      | "thinking"
      | "calling_tool"
      | "waiting_for_message"
      | "waiting_for_human"
      | "suspended"
      | "completed"
      | "failed"
    > = ["thinking", "calling_tool", "completed"];
    for (const transition of states) {
      recorder.record({
        kind: "lifecycle",
        at: Date.now(),
        agent: "test-agent" as never,
        transition,
      });
    }
    await recorder.end(sessionId);

    const lines = readJsonlLines(fp);
    // session.start + 3 lifecycle + session.end = 5 lines
    expect(lines.length).toBe(5);
    expect(lines[0]?.type).toBe("session.start");
    expect(lines[4]?.type).toBe("session.end");

    // Check lifecycle order
    const lifecycleLines = lines.slice(1, 4);
    for (let i = 0; i < states.length; i++) {
      const line = lifecycleLines[i];
      if (line?.type === "lifecycle") {
        expect(line.transition).toBe(states[i]);
      }
    }
  });

  it("works without filePath (in-memory only)", async () => {
    const recorder = makeRecorder();
    const sessionId = "test-sess-mem" as SessionId;
    const contractId = "test-contract" as ContractId;

    recorder.start(sessionId, contractId);
    recorder.record({
      kind: "lifecycle",
      at: Date.now(),
      agent: "test-agent" as never,
      transition: "idle",
    });
    const result = await recorder.end(sessionId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toHaveLength(1);
    }
  });
});
