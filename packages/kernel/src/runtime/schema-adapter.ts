/**
 * Per-provider JSON-schema adapter.
 *
 * Different model providers interpret JSON Schema tool specs differently:
 * Anthropic wants `required` before `properties`; OpenAI tools do not honor
 * `additionalProperties: false`; both have quirks with `oneOf`/`anyOf`.
 *
 * An adapter transforms a ToolSpec's jsonSchema into the shape each provider
 * prefers, without touching the canonical ToolSpec stored in the registry.
 *
 * See ADR 0031.
 */

import type { ProviderId } from "../contracts/provider.js";
import type { ToolSpec } from "../contracts/tool.js";

// ---- public interface ----

export interface SchemaAdapter {
  readonly name: string;
  /**
   * Given a ToolSpec and the target provider id, return the JSON Schema object
   * the provider's tool-use API should receive. MAY return the same reference
   * unchanged if no transformation is needed.
   */
  adapt(spec: ToolSpec, providerId: ProviderId): unknown;
}

// ---- internal helpers ----

/** Return a shallow clone of `obj` with `key` placed first. */
function hoistKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!(key in obj)) return obj;
  const { [key]: hoisted, ...rest } = obj;
  return { [key]: hoisted, ...rest };
}

/** Strip a key from an object if present. */
function stripKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!(key in obj)) return obj;
  const { [key]: _stripped, ...rest } = obj;
  return rest;
}

/** Keywords that some providers do not support — strip them from leaf nodes. */
const ANTHROPIC_UNSUPPORTED_FORMATS = new Set(["date", "time", "uri", "email", "uuid"]);

function stripUnsupportedFormats(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const obj = schema as Record<string, unknown>;
  let result = { ...obj };

  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
  if ("format" in result && ANTHROPIC_UNSUPPORTED_FORMATS.has(String(result["format"]))) {
    const { format: _f, ...rest } = result;
    result = rest;
  }

  // Recurse into properties
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
  if (result["properties"] && typeof result["properties"] === "object") {
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    const props = result["properties"] as Record<string, unknown>;
    const newProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      newProps[k] = stripUnsupportedFormats(v);
    }
    result = { ...result, properties: newProps };
  }

  // Recurse into items (arrays)
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
  if (result["items"]) {
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    result = { ...result, items: stripUnsupportedFormats(result["items"]) };
  }

  return result;
}

/**
 * Attempt to flatten trivially-wrappable `oneOf`/`anyOf`.
 *
 * If the schema has `oneOf: [X]` (single entry) or `anyOf: [X]` (single entry),
 * inline `X`'s properties into the parent. This covers the common pattern where
 * a wrapper type is generated from `z.union([z.object({...})])`.
 *
 * Only flattens when the single variant is an object type and has no conflicting
 * keys with the parent. In all other cases returns the schema unchanged.
 */
function flattenSingleVariant(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const obj = schema as Record<string, unknown>;

  for (const key of ["oneOf", "anyOf"] as const) {
    const variants = obj[key];
    if (!Array.isArray(variants) || variants.length !== 1) continue;
    const variant = variants[0] as Record<string, unknown>;
    if (typeof variant !== "object" || variant === null) continue;

    // Only flatten object-typed variants to avoid losing type info
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
    if (variant["type"] !== "object" && variant["type"] !== undefined) continue;

    // Check no conflicting top-level keys (except the oneOf/anyOf we're removing)
    const { [key]: _removed, ...parentRest } = obj;
    const conflicts = Object.keys(variant).filter((k) => k in parentRest);
    if (conflicts.length > 0) continue;

    return { ...parentRest, ...variant };
  }
  return schema;
}

// ---- built-in adapters ----

/**
 * No-op adapter: returns jsonSchema unchanged (or derives from inputSchema
 * metadata if jsonSchema is undefined). Falls through to `{ type: "object" }`.
 */
export const defaultAdapter: SchemaAdapter = {
  name: "default",
  adapt(spec: ToolSpec, _providerId: ProviderId): unknown {
    return spec.jsonSchema ?? { type: "object" };
  },
};

/**
 * Anthropic adapter:
 * - Hoists `required` before `properties` (Anthropic's parser is order-sensitive
 *   in some tool-use pipelines — and ForgeCode attributes a measurable win to this).
 * - Flattens single-entry `oneOf`/`anyOf`.
 * - Strips unsupported `format` keywords.
 */
export const anthropicAdapter: SchemaAdapter = {
  name: "anthropic",
  adapt(spec: ToolSpec, _providerId: ProviderId): unknown {
    let schema: unknown = spec.jsonSchema ?? { type: "object" };
    schema = flattenSingleVariant(schema);
    schema = stripUnsupportedFormats(schema);

    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
    const obj = schema as Record<string, unknown>;

    // Hoist `required` before `properties` at top level
    return hoistKey(obj, "required");
  },
};

/**
 * OpenAI adapter:
 * - Properties before required (OpenAI's preferred ordering).
 * - Strips `additionalProperties: false` (causes silent rejections in some models).
 * - Flattens single-entry `oneOf`/`anyOf`.
 */
export const openaiAdapter: SchemaAdapter = {
  name: "openai",
  adapt(spec: ToolSpec, _providerId: ProviderId): unknown {
    let schema: unknown = spec.jsonSchema ?? { type: "object" };
    schema = flattenSingleVariant(schema);

    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
    const obj = schema as Record<string, unknown>;

    // Strip additionalProperties: false — OpenAI tool-use doesn't honor it cleanly
    let result = stripKey(obj, "additionalProperties");

    // Ensure `properties` appears before `required`
    result = hoistKey(result, "type");
    result = hoistKey(result, "properties");

    return result;
  },
};

// ---- registry wired into Kernel ----

/**
 * The adapter registry. Kernel.mountSchemaAdapter() populates this; the
 * agent runner reads from it when serializing provider tool specs.
 *
 * Key: provider id prefix match (exact match first, then "default").
 */
export class SchemaAdapterRegistry {
  private readonly adapters = new Map<string, SchemaAdapter>();

  mount(providerId: string, adapter: SchemaAdapter): void {
    this.adapters.set(providerId, adapter);
  }

  /** Adapt a ToolSpec for the given provider. Falls back to defaultAdapter. */
  adapt(spec: ToolSpec, providerId: ProviderId): unknown {
    const adapter = this.adapters.get(providerId) ?? defaultAdapter;
    return adapter.adapt(spec, providerId);
  }
}
