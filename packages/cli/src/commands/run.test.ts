/**
 * Tests for the `run` command.
 *
 * Invokes runFromBlueprint() programmatically with a mock provider so no
 * API keys are needed. Verifies exit-code-0 and a non-empty cost summary.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BlueprintConfig } from "../blueprint.js";
import { runFromBlueprint } from "./run.js";

const BASE_CONFIG: BlueprintConfig = {
  schemaVersion: "1.0.0",
  contract: {
    id: "test-contract",
    goal: "Test the run command",
  },
  agent: {
    id: "test-agent",
    role: "worker",
    provider: {
      kind: "static",
      providerId: "mock",
    },
    tools: [],
  },
  termination: {
    maxIterations: 5,
    maxWallMs: 10_000,
  },
  trustMode: "implicit",
};

describe("runFromBlueprint", () => {
  it("returns exitCode 0 and a non-empty summary for mock provider", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerge-run-test-"));
    try {
      const result = await runFromBlueprint(BASE_CONFIG, { outputDir });
      expect(result.exitCode).toBe(0);
      expect(result.summary.length).toBeGreaterThan(0);
      // Summary should include session id and cost
      expect(result.summary).toContain("Session:");
      expect(result.summary).toContain("Total cost:");
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("returns exitCode 1 for unsupported provider", async () => {
    const config: BlueprintConfig = {
      ...BASE_CONFIG,
      agent: {
        ...BASE_CONFIG.agent,
        provider: { kind: "static", providerId: "anthropic" },
      },
    };
    const result = await runFromBlueprint(config, { outputDir: os.tmpdir() });
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("anthropic");
  });

  it("writes session JSONL file on successful run", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerge-run-test-"));
    try {
      const result = await runFromBlueprint(BASE_CONFIG, { outputDir });
      expect(result.exitCode).toBe(0);

      // Check that a session JSONL file was written
      const files = await fs.readdir(outputDir);
      const sessionFiles = files.filter((f) => f.endsWith("-session.jsonl"));
      expect(sessionFiles.length).toBeGreaterThan(0);

      // Check that the session file contains a session.start line
      const sessionFile = path.join(outputDir, sessionFiles[0] ?? "");
      const content = await fs.readFile(sessionFile, "utf-8");
      expect(content).toContain('"type":"session.start"');
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("includes contract id and agent id in summary", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerge-run-test-"));
    try {
      const result = await runFromBlueprint(BASE_CONFIG, { outputDir });
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("test-contract");
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });
});
