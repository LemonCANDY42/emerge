/**
 * Schema adapter unit tests (C6).
 *
 * Covers:
 *  - anthropicAdapter: hoists `required` recursively (C6)
 *  - anthropicAdapter: strips unsupported formats recursively (C6)
 *  - anthropicAdapter: flattens single-variant oneOf at all depths (C6)
 *  - openaiAdapter: strips additionalProperties: false recursively (C6)
 *  - openaiAdapter: flattens single-variant oneOf at all depths (C6)
 */

import { describe, expect, it } from "vitest";
import type { SchemaRef } from "../contracts/common.js";
import type { ToolSpec } from "../contracts/tool.js";
import { anthropicAdapter, openaiAdapter } from "./schema-adapter.js";

function makeSpec(jsonSchema: unknown): ToolSpec {
  return {
    name: "test-tool",
    description: "test",
    inputSchema: {} as SchemaRef,
    jsonSchema,
    permission: { rationale: "test", effects: ["state_read"], defaultMode: "auto" },
  };
}

// Helper: cast to record and access a key safely
function get(obj: unknown, key: string): unknown {
  return (obj as Record<string, unknown>)[key];
}

describe("anthropicAdapter (C6: recursive transformations)", () => {
  it("hoists required before properties at the top level", () => {
    const spec = makeSpec({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    const adapted = anthropicAdapter.adapt(spec, "anthropic" as never) as Record<string, unknown>;
    const keys = Object.keys(adapted);
    expect(keys.indexOf("required")).toBeLessThan(keys.indexOf("properties"));
  });

  it("hoists required recursively inside nested properties (C6)", () => {
    const spec = makeSpec({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { b: { type: "number" } },
          required: ["b"],
        },
      },
    });
    const adapted = anthropicAdapter.adapt(spec, "anthropic" as never) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    const props = adapted["properties"] as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    const nestedKeys = Object.keys(props["nested"] as Record<string, unknown>);
    expect(nestedKeys.indexOf("required")).toBeLessThan(nestedKeys.indexOf("properties"));
  });

  it("hoists required inside items schema (C6)", () => {
    const spec = makeSpec({
      type: "array",
      items: {
        type: "object",
        properties: { c: { type: "boolean" } },
        required: ["c"],
      },
    });
    const adapted = anthropicAdapter.adapt(spec, "anthropic" as never) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    const items = adapted["items"] as Record<string, unknown>;
    const keys = Object.keys(items);
    expect(keys.indexOf("required")).toBeLessThan(keys.indexOf("properties"));
  });

  it("strips unsupported format keywords recursively (C6)", () => {
    const spec = makeSpec({
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        nested: {
          type: "object",
          properties: {
            date: { type: "string", format: "date" },
          },
        },
        regular: { type: "string", format: "password" }, // 'password' is not in unsupported list
      },
    });
    const adapted = anthropicAdapter.adapt(spec, "anthropic" as never) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    const props = adapted["properties"] as Record<string, unknown>;

    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(get(props["email"], "format")).toBeUndefined();

    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    const nestedProps = get(props["nested"], "properties") as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(get(nestedProps["date"], "format")).toBeUndefined();

    // password is not in ANTHROPIC_UNSUPPORTED_FORMATS — preserved
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(get(props["regular"], "format")).toBe("password");
  });

  it("flattens single-variant oneOf at the top level", () => {
    const spec = makeSpec({
      oneOf: [
        {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        },
      ],
    });
    const adapted = anthropicAdapter.adapt(spec, "anthropic" as never) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(adapted["oneOf"]).toBeUndefined();
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(adapted["type"]).toBe("object");
  });

  it("flattens single-variant oneOf nested inside properties (C6: discriminated union)", () => {
    const spec = makeSpec({
      type: "object",
      properties: {
        variant: {
          oneOf: [
            {
              type: "object",
              properties: { kind: { type: "string" } },
            },
          ],
        },
      },
    });
    const adapted = anthropicAdapter.adapt(spec, "anthropic" as never) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    const props = adapted["properties"] as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(get(props["variant"], "oneOf")).toBeUndefined();
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(get(props["variant"], "type")).toBe("object");
  });

  it("does not flatten multi-variant oneOf", () => {
    const spec = makeSpec({
      oneOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    });
    const adapted = anthropicAdapter.adapt(spec, "anthropic" as never) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(Array.isArray(adapted["oneOf"])).toBe(true);
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect((adapted["oneOf"] as unknown[]).length).toBe(2);
  });
});

describe("openaiAdapter (C6: recursive transformations)", () => {
  it("strips additionalProperties: false at the top level", () => {
    const spec = makeSpec({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    });
    const adapted = openaiAdapter.adapt(spec, "openai" as never) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(adapted["additionalProperties"]).toBeUndefined();
  });

  it("strips additionalProperties: false from deeply nested object property (C6)", () => {
    const spec = makeSpec({
      type: "object",
      properties: {
        inner: {
          type: "object",
          properties: { x: { type: "number" } },
          additionalProperties: false,
        },
      },
    });
    const adapted = openaiAdapter.adapt(spec, "openai" as never) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    const props = adapted["properties"] as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(get(props["inner"], "additionalProperties")).toBeUndefined();
  });

  it("strips additionalProperties: false inside items (C6)", () => {
    const spec = makeSpec({
      type: "array",
      items: {
        type: "object",
        properties: { y: { type: "string" } },
        additionalProperties: false,
      },
    });
    const adapted = openaiAdapter.adapt(spec, "openai" as never) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    const items = adapted["items"] as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(items["additionalProperties"]).toBeUndefined();
  });

  it("preserves additionalProperties when it's a schema object (not false)", () => {
    const spec = makeSpec({
      type: "object",
      additionalProperties: { type: "string" },
    });
    const adapted = openaiAdapter.adapt(spec, "openai" as never) as Record<string, unknown>;
    // Should NOT strip when additionalProperties is a schema
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(adapted["additionalProperties"]).toBeDefined();
  });

  it("flattens single-variant anyOf at all depths (C6: discriminated union)", () => {
    const spec = makeSpec({
      type: "object",
      properties: {
        body: {
          anyOf: [
            {
              type: "object",
              properties: { text: { type: "string" } },
            },
          ],
        },
      },
    });
    const adapted = openaiAdapter.adapt(spec, "openai" as never) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    const props = adapted["properties"] as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(get(props["body"], "anyOf")).toBeUndefined();
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    expect(get(props["body"], "type")).toBe("object");
  });
});
