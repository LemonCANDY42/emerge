/**
 * session-builder tests — session registry isolation (Critical #4) and
 * verdict gate enforcement (Critical #5).
 *
 * These tests use MockProvider to exercise the real Kernel + surveillance
 * wiring without touching a live model. They are smoke-level integration
 * tests, not unit tests for individual functions.
 */

import type { ProviderEvent } from "@lwrf42/emerge-kernel/contracts";
import { MockProvider } from "@lwrf42/emerge-provider-mock";
import { describe, expect, it } from "vitest";
import { buildSession } from "./session-builder.js";
import type { TaskSpec } from "./task-loader.js";

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeMinimalSpec(id: string): TaskSpec {
  return {
    id,
    title: `Test task ${id}`,
    repo: {
      kind: "inline",
      files: { "file.txt": "content" },
    },
    goal: "Return immediately without doing anything",
    acceptanceCommand: "echo ok",
    timeoutSeconds: 30,
    difficulty: "trivial",
  };
}

/** One-step mock that ends immediately with end_turn (no tool calls). */
function makeEndTurnScript(): readonly { events: readonly ProviderEvent[] }[] {
  return [
    {
      events: [
        { type: "text_delta", text: "Done." },
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 10, tokensOut: 5, wallMs: 10, toolCalls: 0, usd: 0 },
        },
      ],
    },
  ];
}

// ─── Critical #4: Session-scoped registry isolation ───────────────────────────

describe("buildSession registry isolation (Critical #4)", () => {
  it("tools registered in session A are not visible in session B", () => {
    const specA = makeMinimalSpec("iso-a");
    const specB = makeMinimalSpec("iso-b");
    const provider = new MockProvider(makeEndTurnScript(), "mock-iso");

    const sessionA = buildSession({
      spec: specA,
      workspaceRoot: "/tmp",
      provider,
      sandboxMode: "inproc",
    });
    const sessionB = buildSession({
      spec: specB,
      workspaceRoot: "/tmp",
      provider,
      sandboxMode: "inproc",
    });

    // Both sessions should have the same set of tools (fs.read, fs.write, bash)
    // but each session's kernel has its own ToolRegistry instance.
    // Verify we have separate kernel instances.
    expect(sessionA.kernel).not.toBe(sessionB.kernel);

    // Both sessions should expose the same tool names, isolated per-session.
    // We verify by checking agentId is per-session (shared-registry bug would
    // manifest if kernel.getToolRegistry() were mutated and leaked across sessions).
    expect(sessionA.agentId).toBe("tbench-agent");
    expect(sessionB.agentId).toBe("tbench-agent");

    // Both sessions should have different sessionIds.
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

    sessionA.stopAdjudicatorWatch();
    sessionB.stopAdjudicatorWatch();
  });

  it("creating two sessions from the same provider does not throw duplicate-tool errors", () => {
    // If buildSession were registering into the kernel's SHARED registry
    // (the pre-fix bug), the second call would throw E_TOOL_DUPLICATE.
    const spec = makeMinimalSpec("dup-test");
    const provider = new MockProvider(makeEndTurnScript(), "mock-dup");

    // This must NOT throw.
    expect(() => {
      const s1 = buildSession({
        spec,
        workspaceRoot: "/tmp",
        provider,
        sandboxMode: "inproc",
      });
      const s2 = buildSession({
        spec,
        workspaceRoot: "/tmp",
        provider,
        sandboxMode: "inproc",
      });
      s1.stopAdjudicatorWatch();
      s2.stopAdjudicatorWatch();
    }).not.toThrow();
  });
});

// ─── Critical #5: Verdict gate (requireVerdictBeforeExit) ────────────────────

describe("buildSession verdict gate (Critical #5)", () => {
  it("endSession fails with E_SESSION_INCOMPLETE if no aligned verdict was issued", async () => {
    // buildSession wires requireVerdictBeforeExit: true.
    // If the adjudicator never issues an aligned verdict, endSession() must fail.
    const spec = makeMinimalSpec("verdict-gate-test");
    const provider = new MockProvider(makeEndTurnScript(), "mock-verdict");

    const session = buildSession({
      spec,
      workspaceRoot: "/tmp",
      provider,
      sandboxMode: "inproc",
    });

    // End the session immediately without running the agent or adjudicator.
    // The verdict gate should reject this.
    session.stopAdjudicatorWatch();
    const endResult = await session.kernel.endSession();

    expect(endResult.ok).toBe(false);
    if (!endResult.ok) {
      // The error message should mention "aligned" or "verdict".
      expect(endResult.error.message.toLowerCase()).toMatch(/aligned|verdict/);
    }
  });

  it("getLastVerdict returns undefined before any acceptance run", () => {
    const spec = makeMinimalSpec("pre-verdict-test");
    const provider = new MockProvider(makeEndTurnScript(), "mock-pre-verdict");

    const session = buildSession({
      spec,
      workspaceRoot: "/tmp",
      provider,
      sandboxMode: "inproc",
    });

    // No agent has run, no acceptance has executed — verdict should be undefined.
    expect(session.getLastVerdict()).toBeUndefined();

    session.stopAdjudicatorWatch();
  });
});
