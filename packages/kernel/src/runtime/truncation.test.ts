/**
 * Truncation helper unit tests (C1).
 *
 * Covers:
 *  - Single notice application (applyTruncationNotice prepends notice once)
 *  - Idempotency: calling applyTruncationNotice twice only prepends once
 *  - maybeApplyTruncationNotice respects existing meta.truncationNoticed sentinel
 *  - No notice when fullSize <= previewSize
 */

import { describe, expect, it } from "vitest";
import type { ToolResult } from "../contracts/tool.js";
import { applyTruncationNotice, maybeApplyTruncationNotice } from "./truncation.js";

function makeResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    ok: true,
    preview: "hello world",
    ...overrides,
  };
}

describe("applyTruncationNotice", () => {
  it("prepends the truncation notice when fullSize > previewSize", () => {
    const base = makeResult({ preview: "short" });
    const result = applyTruncationNotice(base, 1000, 5);
    expect(result.preview).toMatch(/^\[TRUNCATED:/);
    expect(result.preview).toContain("short");
    expect(result.sizeBytes).toBe(1000);
  });

  it("returns unchanged result when fullSize <= previewSize", () => {
    const base = makeResult({ preview: "complete", sizeBytes: 8 });
    const result = applyTruncationNotice(base, 8, 8);
    expect(result).toBe(base); // same reference
  });

  it("sets meta.truncationNoticed = true after applying", () => {
    const base = makeResult({ preview: "x" });
    const result = applyTruncationNotice(base, 100, 1);
    expect(result.meta).toBeDefined();
    const meta = result.meta as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(meta["truncationNoticed"]).toBe(true);
  });

  it("is idempotent: calling twice only prepends the notice once (C1)", () => {
    const base = makeResult({ preview: "data" });
    const once = applyTruncationNotice(base, 1000, 4);
    const twice = applyTruncationNotice(once, 1000, once.preview.length);

    // The preview should only start with one [TRUNCATED: ...] prefix
    const matches = twice.preview.match(/\[TRUNCATED:/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(1);
  });

  it("preserves existing meta fields when adding truncationNoticed", () => {
    const base = makeResult({ preview: "y", meta: { foo: "bar" } });
    const result = applyTruncationNotice(base, 1000, 1);
    expect(result.meta).toBeDefined();
    const meta = result.meta as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(meta["foo"]).toBe("bar");
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(meta["truncationNoticed"]).toBe(true);
  });

  it("includes handle in notice when handle is set", () => {
    const base = makeResult({ preview: "partial", handle: "artifact-1" });
    const result = applyTruncationNotice(base, 500, 7);
    expect(result.preview).toContain("read_handle('artifact-1')");
  });
});

describe("maybeApplyTruncationNotice", () => {
  it("does nothing when sizeBytes is undefined", () => {
    const base = makeResult({ preview: "full" });
    const result = maybeApplyTruncationNotice(base);
    expect(result).toBe(base);
  });

  it("does nothing when sizeBytes equals preview.length", () => {
    const base = makeResult({ preview: "complete", sizeBytes: 8 });
    const result = maybeApplyTruncationNotice(base);
    expect(result.preview).toBe("complete");
  });

  it("applies notice when sizeBytes > preview.length", () => {
    const base = makeResult({ preview: "truncated", sizeBytes: 5000 });
    const result = maybeApplyTruncationNotice(base);
    expect(result.preview).toMatch(/^\[TRUNCATED:/);
  });

  it("respects existing meta.truncationNoticed sentinel — no double-apply (C1)", () => {
    // Simulate a result that already had applyTruncationNotice called (e.g. from makeFsReadTool)
    // Build meta with bracket notation to satisfy noPropertyAccessFromIndexSignature
    const sentinelMeta: Record<string, unknown> = {};
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    sentinelMeta["truncationNoticed"] = true;
    const base = makeResult({
      preview: "[TRUNCATED: showing 5 of 5000 bytes.]\nsome content",
      sizeBytes: 5000,
      meta: sentinelMeta,
    });
    const result = maybeApplyTruncationNotice(base);
    // Should return unchanged — no second notice prepended
    expect(result).toBe(base);
    const matches = result.preview.match(/\[TRUNCATED:/g);
    expect(matches?.length).toBe(1);
  });

  it("C1 regression: calling both applyTruncationNotice then maybeApplyTruncationNotice yields single notice", () => {
    // This is exactly the scenario in makeFsReadTool (C1 bug before fix)
    const rawContent = "x".repeat(5000);
    const PREVIEW_LIMIT = 100;
    const preview = rawContent.slice(0, PREVIEW_LIMIT);

    // Step 1: makeFsReadTool calls applyTruncationNotice directly
    const afterApply = applyTruncationNotice(
      { ok: true, preview, sizeBytes: rawContent.length },
      rawContent.length,
      preview.length,
    );

    // Step 2: agent-runner calls maybeApplyTruncationNotice on the same result
    const afterMaybe = maybeApplyTruncationNotice(afterApply);

    // Assert: only one [TRUNCATED: prefix
    const matches = afterMaybe.preview.match(/\[TRUNCATED:/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(1);
  });
});
