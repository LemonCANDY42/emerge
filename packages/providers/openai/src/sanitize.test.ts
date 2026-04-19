/**
 * Tests for tool name sanitization helpers.
 *
 * sanitizeToolName: maps dotted emerge tool names to OpenAI-safe wire names.
 * buildToolNameMap: builds a per-request bidirectional name map.
 *
 * OpenAI tool name constraint: ^[a-zA-Z0-9_-]+$
 */

import { describe, expect, it } from "vitest";
import { buildToolNameMap, sanitizeToolName } from "./sanitize.js";

// ---------------------------------------------------------------------------
// sanitizeToolName
// ---------------------------------------------------------------------------

describe("sanitizeToolName", () => {
  it("replaces a single dot: fs.read → fs_read", () => {
    const result = sanitizeToolName("fs.read");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.wire).toBe("fs_read");
  });

  it("replaces multiple dots: fs.read.foo → fs_read_foo", () => {
    const result = sanitizeToolName("fs.read.foo");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.wire).toBe("fs_read_foo");
  });

  it("is a no-op for already-valid names without dots: fs_read", () => {
    const result = sanitizeToolName("fs_read");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.wire).toBe("fs_read");
  });

  it("is a no-op for simple identifier: bash", () => {
    const result = sanitizeToolName("bash");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.wire).toBe("bash");
  });

  it("preserves hyphens (they are valid): my-tool", () => {
    const result = sanitizeToolName("my-tool");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.wire).toBe("my-tool");
  });

  it("accepts names with digits: tool2", () => {
    const result = sanitizeToolName("tool2");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.wire).toBe("tool2");
  });

  it("returns ok=false for slash: tool/x", () => {
    const result = sanitizeToolName("tool/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("tool/x");
  });

  it("returns ok=false for colon: tool:x", () => {
    const result = sanitizeToolName("tool:x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("tool:x");
  });

  it("returns ok=false for space: tool x", () => {
    const result = sanitizeToolName("tool x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("tool x");
  });

  it("returns ok=false for at-sign: @tool", () => {
    const result = sanitizeToolName("@tool");
    expect(result.ok).toBe(false);
  });

  it("is idempotent: sanitizing twice produces same wire name", () => {
    const first = sanitizeToolName("fs.write");
    if (!first.ok) throw new Error("Expected ok");
    const second = sanitizeToolName(first.wire);
    if (!second.ok) throw new Error("Expected ok");
    expect(first.wire).toBe(second.wire);
  });
});

// ---------------------------------------------------------------------------
// buildToolNameMap
// ---------------------------------------------------------------------------

describe("buildToolNameMap", () => {
  it("builds forward and reverse maps for dotted names", () => {
    const map = buildToolNameMap([{ name: "fs.read" }, { name: "fs.write" }]);

    expect(map.originalToWire.get("fs.read")).toBe("fs_read");
    expect(map.originalToWire.get("fs.write")).toBe("fs_write");
    expect(map.wireToOriginal.get("fs_read")).toBe("fs.read");
    expect(map.wireToOriginal.get("fs_write")).toBe("fs.write");
  });

  it("round-trip: wireToOriginal(sanitize(name)) === original name", () => {
    const tools = [{ name: "fs.read" }, { name: "bash" }, { name: "my-tool" }];
    const map = buildToolNameMap(tools);

    for (const tool of tools) {
      const wireResult = sanitizeToolName(tool.name);
      if (!wireResult.ok) throw new Error("Expected ok");
      expect(map.wireToOriginal.get(wireResult.wire)).toBe(tool.name);
    }
  });

  it("handles already-valid names without dots", () => {
    const map = buildToolNameMap([{ name: "bash" }, { name: "list_files" }]);

    expect(map.originalToWire.get("bash")).toBe("bash");
    expect(map.wireToOriginal.get("bash")).toBe("bash");
    expect(map.originalToWire.get("list_files")).toBe("list_files");
  });

  it("handles an empty tool list", () => {
    const map = buildToolNameMap([]);
    expect(map.wireToOriginal.size).toBe(0);
    expect(map.originalToWire.size).toBe(0);
  });

  it("throws on illegal characters that survive dot-replacement", () => {
    expect(() => buildToolNameMap([{ name: "tool/x" }])).toThrow(/cannot be safely sanitized/);
  });

  it("throws on colon names that survive dot-replacement", () => {
    expect(() => buildToolNameMap([{ name: "tool:x" }])).toThrow(/cannot be safely sanitized/);
  });

  it("throws on name collision: fs.read and fs_read both → fs_read", () => {
    expect(() => buildToolNameMap([{ name: "fs.read" }, { name: "fs_read" }])).toThrow(/collision/);
  });

  it("does not throw when two names happen to be same after no change", () => {
    // same name twice would normally be a usage error, but if the tool list
    // has duplicates, only the first wins and there's no collision since both
    // have the same original
    const map = buildToolNameMap([{ name: "bash" }, { name: "bash" }]);
    expect(map.wireToOriginal.get("bash")).toBe("bash");
  });
});
