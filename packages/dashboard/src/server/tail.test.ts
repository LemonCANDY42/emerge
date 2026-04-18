/**
 * Tests for the JSONL tail primitive.
 */

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSONL_SCHEMA_VERSION } from "@emerge/kernel/contracts";
import type { JsonlEvent } from "@emerge/kernel/contracts";
import { describe, expect, it } from "vitest";
import { readAllLines, tailFile } from "./tail.js";

function makeLifecycle(at: number): JsonlEvent {
  return {
    v: JSONL_SCHEMA_VERSION,
    type: "lifecycle",
    at,
    agent: "agent-a" as import("@emerge/kernel/contracts").AgentId,
    transition: "thinking" as import("@emerge/kernel/contracts").AgentState,
  };
}

function writeTempJsonl(events: JsonlEvent[]): string {
  const dir = mkdtempSync(join(tmpdir(), "emerge-tail-test-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");
  return path;
}

describe("readAllLines", () => {
  it("returns all valid events from a populated file", async () => {
    const events = [makeLifecycle(1000), makeLifecycle(2000)];
    const path = writeTempJsonl(events);
    const result = await readAllLines(path);
    expect(result).toHaveLength(2);
    expect(result[0]?.type).toBe("lifecycle");
  });

  it("returns empty array for an empty file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emerge-tail-test-"));
    const path = join(dir, "empty.jsonl");
    writeFileSync(path, "", "utf-8");
    const result = await readAllLines(path);
    expect(result).toHaveLength(0);
  });

  it("skips bad lines and continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emerge-tail-test-"));
    const path = join(dir, "bad.jsonl");
    writeFileSync(
      path,
      `${[
        JSON.stringify(makeLifecycle(1000)),
        "NOT JSON",
        '{"v":"1.0.0","type":"unknown_xyz","at":2000}',
        JSON.stringify(makeLifecycle(3000)),
      ].join("\n")}\n`,
      "utf-8",
    );
    const result = await readAllLines(path);
    // Only the 2 valid events survive
    expect(result).toHaveLength(2);
  });
});

describe("tailFile", () => {
  it("calls onEvent for lines appended after start", async () => {
    const path = writeTempJsonl([makeLifecycle(1000)]);
    const received: JsonlEvent[] = [];

    const tailer = tailFile(path, (ev) => received.push(ev));

    // Wait for initial read
    await new Promise<void>((r) => setTimeout(r, 400));
    const countAfterInit = received.length;

    // Append a new line
    appendFileSync(path, `${JSON.stringify(makeLifecycle(2000))}\n`, "utf-8");

    // Wait for the poll
    await new Promise<void>((r) => setTimeout(r, 500));
    tailer.stop();

    expect(received.length).toBeGreaterThan(countAfterInit);
    const last = received[received.length - 1];
    expect(last?.at).toBe(2000);
  });

  it("stop() prevents further callbacks after first read", async () => {
    const path = writeTempJsonl([makeLifecycle(1000)]);
    const received: JsonlEvent[] = [];
    const tailer = tailFile(path, (ev) => received.push(ev));

    // Wait for the initial read to complete
    await new Promise<void>((r) => setTimeout(r, 400));
    const countAfterInit = received.length;

    // Stop the tailer
    tailer.stop();

    // Append more events
    appendFileSync(path, `${JSON.stringify(makeLifecycle(2000))}\n`, "utf-8");
    appendFileSync(path, `${JSON.stringify(makeLifecycle(3000))}\n`, "utf-8");

    // Wait longer than 1 poll interval
    await new Promise<void>((r) => setTimeout(r, 600));

    // No additional events should have been received after stop()
    expect(received.length).toBe(countAfterInit);
  });

  it("recovers after file truncation (regression #4)", async () => {
    const { writeFileSync: writeFs } = await import("node:fs");

    const path = writeTempJsonl([makeLifecycle(1000), makeLifecycle(2000)]);
    const received: JsonlEvent[] = [];
    const tailer = tailFile(path, (ev) => received.push(ev));

    // Wait for initial read
    await new Promise<void>((r) => setTimeout(r, 400));
    const countAfterInit = received.length;

    // Truncate the file and write a fresh event
    writeFs(path, `${JSON.stringify(makeLifecycle(3000))}\n`, "utf-8");

    // Wait for tailer to recover and pick up the new event
    await new Promise<void>((r) => setTimeout(r, 600));
    tailer.stop();

    // The tailer must have recovered — we should see the event written after truncation
    expect(received.length).toBeGreaterThan(countAfterInit);
    const timestamps = received.map((e) => e.at);
    expect(timestamps).toContain(3000);
  });

  it("skips bad lines in tail mode", async () => {
    const path = writeTempJsonl([makeLifecycle(1000)]);
    const received: JsonlEvent[] = [];
    const tailer = tailFile(path, (ev) => received.push(ev));

    await new Promise<void>((r) => setTimeout(r, 300));

    appendFileSync(path, "NOT JSON\n", "utf-8");
    appendFileSync(path, `${JSON.stringify(makeLifecycle(2000))}\n`, "utf-8");

    await new Promise<void>((r) => setTimeout(r, 500));
    tailer.stop();

    // Should have received events (initial + new valid one) but not the bad line
    const allTypes = received.map((e) => e.type);
    expect(allTypes.every((t) => t === "lifecycle")).toBe(true);
  });
});
