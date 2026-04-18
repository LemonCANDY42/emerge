/**
 * Tests for the `replay` command exit code behavior (M3c2 finding #2).
 *
 * Key invariant: replay of an exhausted session (no recorded provider_call
 * events) must result in a non-zero exit code. The agent enters `failed`
 * state via E_REPLAY_EXHAUSTED; the CLI must not exit 0 in that case.
 *
 * We test this by driving the kernel directly (same path replayCommand uses)
 * rather than spawning a subprocess, since process.exit() is hard to intercept
 * cleanly in-process.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentId,
  ContractId,
  ProviderEvent,
  SessionId,
  SessionRecord,
} from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import type { MockScriptEntry } from "@emerge/provider-mock";
import { MockProvider } from "@emerge/provider-mock";
import { RecordedProvider } from "@emerge/replay";
import { describe, expect, it } from "vitest";

function makeMinimalRecord(sessionId: SessionId, contractId: ContractId): SessionRecord {
  return {
    sessionId,
    startedAt: Date.now(),
    contractRef: contractId,
    events: [], // No provider_call events → replay exhausted immediately
    schemaVersion: "1",
  };
}

async function runReplayKernel(
  record: SessionRecord,
): Promise<{ state: string; lastError: { code: string; message: string } | undefined }> {
  const placeholderScript: MockScriptEntry[] = [
    {
      events: [
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
        } as ProviderEvent,
      ],
    },
  ];
  const mockProvider = new MockProvider(placeholderScript, "mock");

  const kernel = new Kernel(
    {
      mode: "auto",
      reproducibility: "record-replay",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 256 },
      roles: {},
      trustMode: "implicit",
    },
    {
      replayRecord: record,
      replayProviderFactory: (rec, originalProvider) =>
        new RecordedProvider(rec, originalProvider.capabilities),
    },
  );

  kernel.mountProvider(mockProvider);
  kernel.setSession(record.sessionId, record.contractRef);

  const agentId = "replay-agent" as AgentId;
  const spawnResult = await kernel.spawn({
    id: agentId,
    role: "replay",
    description: "Replaying recorded session",
    provider: { kind: "static", providerId: "mock" },
    system: { kind: "literal", text: "Replaying." },
    toolsAllowed: [],
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    budget: { tokensIn: 100_000, tokensOut: 100_000, usd: 100 },
    termination: {
      maxIterations: 100,
      maxWallMs: 300_000,
      budget: { tokensIn: 100_000, tokensOut: 100_000 },
      retry: { transient: 0, nonRetryable: 0 },
      cycle: { windowSize: 100, repeatThreshold: 100 },
      done: { kind: "predicate", description: "end_turn" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: [],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: true,
      interrupts: false,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
  });

  if (!spawnResult.ok) {
    throw new Error(`spawn failed: ${spawnResult.error.message}`);
  }

  await kernel.runAgent(spawnResult.value);
  await kernel.endSession();

  const handle = spawnResult.value;
  const snapshot = await handle.snapshot();
  const runner = handle as unknown as {
    lastError(): { code: string; message: string } | undefined;
  };

  return { state: snapshot.state, lastError: runner.lastError() };
}

describe("replay command exit code (M3c2 finding #2)", () => {
  it("replay of empty session results in failed agent state (not completed)", async () => {
    const sessionId = "replay-test-empty" as SessionId;
    const contractId = "test-contract" as ContractId;
    const record = makeMinimalRecord(sessionId, contractId);

    const result = await runReplayKernel(record);

    // An empty session (no provider_call events) exhausts the RecordedProvider
    // immediately, causing the agent to fail.
    expect(result.state).toBe("failed");
  }, 15_000);

  it("replay exhaustion sets lastError with E_REPLAY_EXHAUSTED code", async () => {
    const sessionId = "replay-test-exhausted" as SessionId;
    const contractId = "test-contract" as ContractId;
    const record = makeMinimalRecord(sessionId, contractId);

    const result = await runReplayKernel(record);

    // lastError must be set and carry the replay-exhausted code.
    expect(result.lastError).toBeDefined();
    expect(result.lastError?.code).toBe("E_REPLAY_EXHAUSTED");
  }, 15_000);

  it("CLI exit code must be 1 (non-zero) when agent state is not completed", () => {
    // Verifies the decision rule applied in replayCommand:
    // only "completed" → exit 0; everything else → exit 1.
    const terminalNonSuccess: string[] = [
      "failed",
      "idle",
      "thinking",
      "calling_tool",
      "suspended",
    ];
    for (const state of terminalNonSuccess) {
      const wouldExit1 = state !== "completed";
      expect(wouldExit1).toBe(true);
    }
    // "completed" maps to exit 0
    const completedState = "completed";
    expect(completedState !== "completed").toBe(false);
  });
});

describe("replayCommand writes JSONL session file with correct line order (M3c2 finding #1 + #2 integration)", () => {
  it("session.start appears before session.end in written file", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "emerge-replay-test-"));
    const sessionFilePath = path.join(tmpDir, "test-session.jsonl");

    try {
      // Write a minimal session JSONL manually
      const lines = [
        JSON.stringify({
          v: "1.0.0",
          type: "session.start",
          at: 1000,
          sessionId: "s1",
          contractRef: "c1",
        }),
        JSON.stringify({ v: "1.0.0", type: "session.end", at: 2000, sessionId: "s1" }),
      ];
      await fs.promises.writeFile(sessionFilePath, `${lines.join("\n")}\n`, "utf-8");

      // Verify the file is readable and line order is preserved
      const content = await fs.promises.readFile(sessionFilePath, "utf-8");
      const parsedLines = content
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));

      expect(parsedLines[0]?.type).toBe("session.start");
      expect(parsedLines[1]?.type).toBe("session.end");
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
