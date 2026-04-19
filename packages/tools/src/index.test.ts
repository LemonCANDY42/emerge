/**
 * @emerge/tools — unit tests for FS tools with baseDir constraint.
 *
 * Tests verify:
 *   - Default behavior (no baseDir) passes through paths unchanged.
 *   - With baseDir: relative paths are resolved inside the workspace.
 *   - With baseDir: "../escape" paths return E_PATH_ESCAPE.
 *   - With baseDir: absolute paths outside baseDir return E_PATH_ESCAPE.
 *   - With baseDir: subdir/file.txt lands inside the workspace.
 *   - Existing fs-tool behavior is unchanged when baseDir is undefined.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ContractError,
  Result,
  Sandbox,
  SandboxDecision,
  SandboxRequest,
} from "@emerge/kernel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFsReadTool, makeFsWriteTool } from "./index.js";

// ─── Passthrough sandbox for testing ─────────────────────────────────────────

/** A no-op sandbox that always allows and runs the callback. */
const passthroughSandbox: Sandbox = {
  async authorize(_req: SandboxRequest): Promise<Result<SandboxDecision, ContractError>> {
    return { ok: true, value: { kind: "allow" } };
  },
  async run<T>(_req: SandboxRequest, fn: () => Promise<T>): Promise<Result<T, ContractError>> {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return {
        ok: false,
        error: { code: "E_SANDBOX", message: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};

// ─── Shared temp workspace ────────────────────────────────────────────────────

let tmpWorkspace: string;

beforeAll(async () => {
  tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "tools-unit-"));
  // Create a subdir so subdir path tests work.
  await fs.mkdir(path.join(tmpWorkspace, "subdir"), { recursive: true });
  // Seed a readable file.
  await fs.writeFile(path.join(tmpWorkspace, "existing.txt"), "hello", "utf-8");
});

afterAll(async () => {
  await fs.rm(tmpWorkspace, { recursive: true, force: true });
});

// ─── makeFsWriteTool ─────────────────────────────────────────────────────────

describe("makeFsWriteTool — baseDir constraint", () => {
  it("writes to a relative path inside baseDir", async () => {
    const tool = makeFsWriteTool(passthroughSandbox, { baseDir: tmpWorkspace });
    const result = await tool.invoke({
      toolCallId: "tc-1" as never,
      callerAgent: "test" as never,
      name: "fs.write",
      input: { path: "subdir/relative.txt", content: "hello relative" },
    });
    expect(result.ok).toBe(true);
    const written = await fs.readFile(path.join(tmpWorkspace, "subdir", "relative.txt"), "utf-8");
    expect(written).toBe("hello relative");
  });

  it("writes to an absolute path inside baseDir", async () => {
    const tool = makeFsWriteTool(passthroughSandbox, { baseDir: tmpWorkspace });
    const target = path.join(tmpWorkspace, "absolute-inside.txt");
    const result = await tool.invoke({
      toolCallId: "tc-2" as never,
      callerAgent: "test" as never,
      name: "fs.write",
      input: { path: target, content: "hello absolute" },
    });
    expect(result.ok).toBe(true);
    const written = await fs.readFile(target, "utf-8");
    expect(written).toBe("hello absolute");
  });

  it("rejects '../escape' traversal with E_PATH_ESCAPE", async () => {
    const tool = makeFsWriteTool(passthroughSandbox, { baseDir: tmpWorkspace });
    const result = await tool.invoke({
      toolCallId: "tc-3" as never,
      callerAgent: "test" as never,
      name: "fs.write",
      input: { path: "../escape.txt", content: "bad" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PATH_ESCAPE");
    }
  });

  it("rejects an absolute path outside baseDir with E_PATH_ESCAPE", async () => {
    const tool = makeFsWriteTool(passthroughSandbox, { baseDir: tmpWorkspace });
    const result = await tool.invoke({
      toolCallId: "tc-4" as never,
      callerAgent: "test" as never,
      name: "fs.write",
      input: { path: "/tmp/outside.txt", content: "bad" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PATH_ESCAPE");
    }
  });

  it("default (no baseDir) writes without constraint", async () => {
    const target = path.join(tmpWorkspace, "unconstrained.txt");
    const tool = makeFsWriteTool(passthroughSandbox);
    const result = await tool.invoke({
      toolCallId: "tc-5" as never,
      callerAgent: "test" as never,
      name: "fs.write",
      input: { path: target, content: "unconstrained" },
    });
    expect(result.ok).toBe(true);
    const written = await fs.readFile(target, "utf-8");
    expect(written).toBe("unconstrained");
  });
});

// ─── makeFsReadTool ──────────────────────────────────────────────────────────

describe("makeFsReadTool — baseDir constraint", () => {
  it("reads a file at a relative path inside baseDir", async () => {
    const tool = makeFsReadTool(passthroughSandbox, { baseDir: tmpWorkspace });
    const result = await tool.invoke({
      toolCallId: "tc-r1" as never,
      callerAgent: "test" as never,
      name: "fs.read",
      input: { path: "existing.txt" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.preview).toContain("hello");
    }
  });

  it("reads a file at an absolute path inside baseDir", async () => {
    const tool = makeFsReadTool(passthroughSandbox, { baseDir: tmpWorkspace });
    const target = path.join(tmpWorkspace, "existing.txt");
    const result = await tool.invoke({
      toolCallId: "tc-r2" as never,
      callerAgent: "test" as never,
      name: "fs.read",
      input: { path: target },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects '../escape' traversal with E_PATH_ESCAPE", async () => {
    const tool = makeFsReadTool(passthroughSandbox, { baseDir: tmpWorkspace });
    const result = await tool.invoke({
      toolCallId: "tc-r3" as never,
      callerAgent: "test" as never,
      name: "fs.read",
      input: { path: "../escape.txt" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PATH_ESCAPE");
    }
  });

  it("rejects an absolute path outside baseDir with E_PATH_ESCAPE", async () => {
    const tool = makeFsReadTool(passthroughSandbox, { baseDir: tmpWorkspace });
    const result = await tool.invoke({
      toolCallId: "tc-r4" as never,
      callerAgent: "test" as never,
      name: "fs.read",
      input: { path: "/etc/passwd" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PATH_ESCAPE");
    }
  });

  it("default (no baseDir) reads without constraint", async () => {
    const tool = makeFsReadTool(passthroughSandbox);
    const target = path.join(tmpWorkspace, "existing.txt");
    const result = await tool.invoke({
      toolCallId: "tc-r5" as never,
      callerAgent: "test" as never,
      name: "fs.read",
      input: { path: target },
    });
    expect(result.ok).toBe(true);
  });
});
