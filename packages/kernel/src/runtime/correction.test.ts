/**
 * Tests for the pre-dispatch tool-call correction layer (ADR 0034).
 *
 * Each test is load-bearing: it is written to fail when the production
 * heuristic is absent or reverted, and pass only when correctly applied.
 */

import { describe, expect, it } from "vitest";
import type { ToolInvocation } from "../contracts/tool.js";
import { correctToolCall } from "./correction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCall(input: unknown, name = "test-tool"): ToolInvocation {
  return {
    toolCallId: "tc-1" as never,
    callerAgent: "agent-1" as never,
    name,
    input,
  };
}

/** Access a field by string key on an unknown-typed object (avoids index-sig lint conflicts). */
function getField(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  return (obj as Record<string, unknown>)[key];
}

const NUMBER_SCHEMA = {
  type: "object",
  properties: {
    count: { type: "number" },
  },
  required: ["count"],
};

const BOOLEAN_SCHEMA = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
  },
};

const DEFAULT_SCHEMA = {
  type: "object",
  properties: {
    timeout: { type: "number", default: 5000 },
    mode: { type: "string", default: "auto" },
  },
};

const OBJECT_SCHEMA = {
  type: "object",
  properties: {
    config: { type: "object" },
  },
};

const ARRAY_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array" },
  },
};

// ---------------------------------------------------------------------------
// type-coerce: number from string
// ---------------------------------------------------------------------------

describe("type-coerce: number from string", () => {
  it("coerces '42' to 42 when spec says number", () => {
    const call = makeCall({ count: "42" });
    const { call: corrected, fixes } = correctToolCall(call, NUMBER_SCHEMA);

    expect(getField(corrected.input, "count")).toBe(42);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({
      kind: "type-coerce",
      field: "count",
      before: "42",
      after: 42,
    });
  });

  it("coerces '0' to 0 (falsy number)", () => {
    const call = makeCall({ count: "0" });
    const { call: corrected, fixes } = correctToolCall(call, NUMBER_SCHEMA);

    expect(getField(corrected.input, "count")).toBe(0);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.kind).toBe("type-coerce");
  });

  it("does NOT coerce '42.5abc' — non-round-tripping string", () => {
    const call = makeCall({ count: "42.5abc" });
    const { call: corrected, fixes } = correctToolCall(call, NUMBER_SCHEMA);

    // Field should be left unchanged (not a valid number string)
    expect(getField(corrected.input, "count")).toBe("42.5abc");
    expect(fixes).toHaveLength(0);
  });

  it("no-op when field is already a number", () => {
    const call = makeCall({ count: 42 });
    const { call: corrected, fixes } = correctToolCall(call, NUMBER_SCHEMA);

    expect(corrected).toBe(call); // Same reference — zero allocation
    expect(fixes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// type-coerce: boolean from string
// ---------------------------------------------------------------------------

describe("type-coerce: boolean from string", () => {
  it("coerces 'true' to true", () => {
    const call = makeCall({ enabled: "true" });
    const { call: corrected, fixes } = correctToolCall(call, BOOLEAN_SCHEMA);

    expect(getField(corrected.input, "enabled")).toBe(true);
    expect(fixes[0]).toMatchObject({
      kind: "type-coerce",
      field: "enabled",
      before: "true",
      after: true,
    });
  });

  it("coerces 'false' to false", () => {
    const call = makeCall({ enabled: "false" });
    const { call: corrected, fixes } = correctToolCall(call, BOOLEAN_SCHEMA);

    expect(getField(corrected.input, "enabled")).toBe(false);
    expect(fixes[0]).toMatchObject({
      kind: "type-coerce",
      field: "enabled",
      before: "false",
      after: false,
    });
  });

  it("coerces 'True' (mixed case) to true", () => {
    const call = makeCall({ enabled: "True" });
    const { call: corrected, fixes } = correctToolCall(call, BOOLEAN_SCHEMA);

    expect(getField(corrected.input, "enabled")).toBe(true);
    expect(fixes).toHaveLength(1);
  });

  it("does NOT coerce '1' or 'yes' — not a canonical boolean string", () => {
    const call = makeCall({ enabled: "1" });
    const { call: corrected, fixes } = correctToolCall(call, BOOLEAN_SCHEMA);

    expect(getField(corrected.input, "enabled")).toBe("1");
    expect(fixes).toHaveLength(0);
  });

  it("no-op when field is already a boolean", () => {
    const call = makeCall({ enabled: true });
    const { call: corrected, fixes } = correctToolCall(call, BOOLEAN_SCHEMA);

    expect(corrected).toBe(call);
    expect(fixes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// default-fill: missing optional fields with defaults
// ---------------------------------------------------------------------------

describe("default-fill: missing optional fields", () => {
  it("fills in missing number field with its declared default", () => {
    const call = makeCall({ mode: "auto" });
    const { call: corrected, fixes } = correctToolCall(call, DEFAULT_SCHEMA);

    expect(getField(corrected.input, "timeout")).toBe(5000);
    expect(getField(corrected.input, "mode")).toBe("auto"); // mode was present — not overwritten
    const timeoutFix = fixes.find((f) => f.field === "timeout");
    expect(timeoutFix).toMatchObject({
      kind: "default-fill",
      field: "timeout",
      before: undefined,
      after: 5000,
    });
  });

  it("fills in missing string field with its declared default", () => {
    const call = makeCall({ timeout: 1000 });
    const { call: corrected, fixes } = correctToolCall(call, DEFAULT_SCHEMA);

    expect(getField(corrected.input, "mode")).toBe("auto");
    const modeFix = fixes.find((f) => f.field === "mode");
    expect(modeFix).toMatchObject({
      kind: "default-fill",
      field: "mode",
      before: undefined,
      after: "auto",
    });
  });

  it("does NOT overwrite a field that is already present", () => {
    const call = makeCall({ timeout: 9999, mode: "manual" });
    const { call: corrected, fixes } = correctToolCall(call, DEFAULT_SCHEMA);

    expect(getField(corrected.input, "timeout")).toBe(9999);
    expect(getField(corrected.input, "mode")).toBe("manual");
    expect(fixes).toHaveLength(0);
  });

  it("no-op when all fields with defaults are already present", () => {
    const call = makeCall({ timeout: 5000, mode: "auto" });
    const { call: corrected, fixes } = correctToolCall(call, DEFAULT_SCHEMA);

    expect(corrected).toBe(call);
    expect(fixes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// string-unescape: JSON-string → object or array
// ---------------------------------------------------------------------------

describe("string-unescape: JSON-string to object/array", () => {
  it("parses JSON-string to object when spec says object", () => {
    const jsonStr = JSON.stringify({ key: "value", nested: 1 });
    const call = makeCall({ config: jsonStr });
    const { call: corrected, fixes } = correctToolCall(call, OBJECT_SCHEMA);

    expect(getField(corrected.input, "config")).toEqual({ key: "value", nested: 1 });
    expect(fixes[0]).toMatchObject({ kind: "string-unescape", field: "config" });
  });

  it("parses JSON-string to array when spec says array", () => {
    const jsonStr = JSON.stringify([1, 2, 3]);
    const call = makeCall({ items: jsonStr });
    const { call: corrected, fixes } = correctToolCall(call, ARRAY_SCHEMA);

    expect(getField(corrected.input, "items")).toEqual([1, 2, 3]);
    expect(fixes[0]).toMatchObject({ kind: "string-unescape", field: "items" });
  });

  it("does NOT substitute when parse result type mismatches (array string for object field)", () => {
    const jsonStr = JSON.stringify([1, 2, 3]);
    const call = makeCall({ config: jsonStr }); // OBJECT_SCHEMA says "object"
    const { call: corrected, fixes } = correctToolCall(call, OBJECT_SCHEMA);

    // config remains the string — wrong type after parse
    expect(getField(corrected.input, "config")).toBe(jsonStr);
    expect(fixes).toHaveLength(0);
  });

  it("leaves field unchanged when JSON.parse fails", () => {
    const call = makeCall({ config: "{ not valid json" });
    const { call: corrected, fixes } = correctToolCall(call, OBJECT_SCHEMA);

    expect(getField(corrected.input, "config")).toBe("{ not valid json");
    expect(fixes).toHaveLength(0);
  });

  it("no-op when field is already an object", () => {
    const call = makeCall({ config: { key: "value" } });
    const { call: corrected, fixes } = correctToolCall(call, OBJECT_SCHEMA);

    expect(corrected).toBe(call);
    expect(fixes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// No-op on already-valid call
// ---------------------------------------------------------------------------

describe("no-op on already-valid call", () => {
  it("returns same call reference (zero allocation) when nothing changes", () => {
    const call = makeCall({ count: 42 });
    const { call: corrected, fixes } = correctToolCall(call, NUMBER_SCHEMA);

    expect(corrected).toBe(call); // Strict reference equality
    expect(fixes).toHaveLength(0);
  });

  it("returns original call when schema is undefined", () => {
    const call = makeCall({ count: "42" });
    const { call: corrected, fixes } = correctToolCall(call, undefined);

    expect(corrected).toBe(call);
    expect(fixes).toHaveLength(0);
  });

  it("returns original call when schema has no properties", () => {
    const call = makeCall({ count: "42" });
    const { call: corrected, fixes } = correctToolCall(call, { type: "object" });

    expect(corrected).toBe(call);
    expect(fixes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// No-op on impossible coercion
// ---------------------------------------------------------------------------

describe("no-op on impossible coercion", () => {
  it("does not coerce a number field when value is an object (incompatible type)", () => {
    const call = makeCall({ count: { nested: true } });
    const { call: corrected, fixes } = correctToolCall(call, NUMBER_SCHEMA);

    expect(getField(corrected.input, "count")).toEqual({ nested: true });
    expect(fixes).toHaveLength(0);
  });

  it("does not coerce when input is not an object", () => {
    const call = makeCall("just a string");
    const { call: corrected, fixes } = correctToolCall(call, NUMBER_SCHEMA);

    expect(corrected).toBe(call);
    expect(fixes).toHaveLength(0);
  });

  it("does not coerce when input is an array", () => {
    const call = makeCall([1, 2, 3]);
    const { call: corrected, fixes } = correctToolCall(call, NUMBER_SCHEMA);

    expect(corrected).toBe(call);
    expect(fixes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple fixes in a single call
// ---------------------------------------------------------------------------

describe("multiple fixes in a single call", () => {
  it("applies both type-coerce and default-fill when both are needed", () => {
    const mixedSchema = {
      type: "object",
      properties: {
        count: { type: "number" },
        mode: { type: "string", default: "auto" },
      },
    };
    // count is a string, mode is missing
    const call = makeCall({ count: "7" });
    const { call: corrected, fixes } = correctToolCall(call, mixedSchema);

    expect(getField(corrected.input, "count")).toBe(7);
    expect(getField(corrected.input, "mode")).toBe("auto");
    expect(fixes).toHaveLength(2);
    expect(fixes.map((f) => f.kind).sort()).toEqual(["default-fill", "type-coerce"]);
  });
});
