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

/**
 * Read a key from a Record<string, unknown> via bracket notation.
 * Required because `noPropertyAccessFromIndexSignature` is enabled globally.
 * This helper lets us avoid per-line biome-ignore suppressions.
 */
function rprop(obj: Record<string, unknown>, key: string): unknown {
  return obj[key];
}

/**
 * Recursively apply a transform to all sub-schemas within `schema`.
 *
 * Descends into: `properties`, `items`, `oneOf`, `anyOf`, `allOf`,
 * `patternProperties`, and `additionalProperties` (when an object, not a boolean).
 * The `transform` is called bottom-up: children are transformed before the parent.
 */
function recurseSchema(
  schema: unknown,
  transform: (s: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const obj = schema as Record<string, unknown>;
  let result = { ...obj };

  // Recurse into properties
  const propsVal = rprop(result, "properties");
  if (propsVal && typeof propsVal === "object" && !Array.isArray(propsVal)) {
    const props = propsVal as Record<string, unknown>;
    const newProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      newProps[k] = recurseSchema(v, transform);
    }
    result = { ...result, properties: newProps };
  }

  // Recurse into items (array schemas)
  const itemsVal = rprop(result, "items");
  if (itemsVal !== undefined) {
    if (Array.isArray(itemsVal)) {
      result = { ...result, items: itemsVal.map((item) => recurseSchema(item, transform)) };
    } else {
      result = { ...result, items: recurseSchema(itemsVal, transform) };
    }
  }

  // Recurse into oneOf / anyOf / allOf
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = result[key];
    if (Array.isArray(variants)) {
      result = { ...result, [key]: variants.map((v) => recurseSchema(v, transform)) };
    }
  }

  // Recurse into patternProperties
  const ppVal = rprop(result, "patternProperties");
  if (ppVal && typeof ppVal === "object" && !Array.isArray(ppVal)) {
    const pp = ppVal as Record<string, unknown>;
    const newPp: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pp)) {
      newPp[k] = recurseSchema(v, transform);
    }
    result = { ...result, patternProperties: newPp };
  }

  // Recurse into additionalProperties (only when it's an object schema, not a boolean)
  const apVal = rprop(result, "additionalProperties");
  if (apVal !== undefined && typeof apVal === "object" && apVal !== null) {
    result = {
      ...result,
      additionalProperties: recurseSchema(apVal as Record<string, unknown>, transform),
    };
  }

  // Apply the transform to the (post-recursion) node
  return transform(result);
}

/** Keywords that some providers do not support — strip them from leaf nodes. */
const ANTHROPIC_UNSUPPORTED_FORMATS = new Set(["date", "time", "uri", "email", "uuid"]);

/**
 * C6: Strip unsupported `format` keywords recursively across the full schema tree.
 */
function stripUnsupportedFormats(schema: unknown): unknown {
  return recurseSchema(schema as Record<string, unknown>, (obj) => {
    if ("format" in obj && ANTHROPIC_UNSUPPORTED_FORMATS.has(String(rprop(obj, "format")))) {
      const { format: _f, ...rest } = obj;
      return rest;
    }
    return obj;
  });
}

/**
 * C6: Strip `additionalProperties: false` recursively across the full schema tree.
 * OpenAI tool-use doesn't honor it cleanly; stripping prevents silent rejections.
 */
function stripAdditionalPropertiesFalse(schema: unknown): unknown {
  return recurseSchema(schema as Record<string, unknown>, (obj) => {
    if (rprop(obj, "additionalProperties") === false) {
      const { additionalProperties: _ap, ...rest } = obj;
      return rest;
    }
    return obj;
  });
}

/**
 * C6: Hoist `required` before `properties` recursively across the full schema tree.
 * Anthropic's parser is order-sensitive in some tool-use pipelines.
 */
function hoistRequiredRecursive(schema: unknown): unknown {
  return recurseSchema(schema as Record<string, unknown>, (obj) => hoistKey(obj, "required"));
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
 *
 * C6: applied recursively via recurseSchema so nested discriminated unions are handled.
 */
function flattenSingleVariant(schema: unknown): unknown {
  return recurseSchema(schema as Record<string, unknown>, (obj) => {
    for (const key of ["oneOf", "anyOf"] as const) {
      const variants = obj[key];
      if (!Array.isArray(variants) || variants.length !== 1) continue;
      const variant = variants[0] as Record<string, unknown>;
      if (typeof variant !== "object" || variant === null) continue;

      // Only flatten object-typed variants to avoid losing type info
      if (rprop(variant, "type") !== "object" && rprop(variant, "type") !== undefined) continue;

      // Check no conflicting top-level keys (except the oneOf/anyOf we're removing)
      const { [key]: _removed, ...parentRest } = obj;
      const conflicts = Object.keys(variant).filter((k) => k in parentRest);
      if (conflicts.length > 0) continue;

      return { ...parentRest, ...variant };
    }
    return obj;
  });
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
 * - Hoists `required` before `properties` at ALL depths (C6: recursive).
 * - Flattens single-entry `oneOf`/`anyOf` at ALL depths (C6: recursive).
 * - Strips unsupported `format` keywords at ALL depths (C6: recursive).
 */
export const anthropicAdapter: SchemaAdapter = {
  name: "anthropic",
  adapt(spec: ToolSpec, _providerId: ProviderId): unknown {
    let schema: unknown = spec.jsonSchema ?? { type: "object" };
    // C6: all three transformations are now fully recursive
    schema = flattenSingleVariant(schema);
    schema = stripUnsupportedFormats(schema);
    schema = hoistRequiredRecursive(schema);
    return schema;
  },
};

/**
 * OpenAI adapter:
 * - Properties before required (OpenAI's preferred ordering).
 * - Strips `additionalProperties: false` at ALL depths (C6: recursive).
 * - Flattens single-entry `oneOf`/`anyOf` at ALL depths (C6: recursive).
 */
export const openaiAdapter: SchemaAdapter = {
  name: "openai",
  adapt(spec: ToolSpec, _providerId: ProviderId): unknown {
    let schema: unknown = spec.jsonSchema ?? { type: "object" };
    // C6: flattenSingleVariant and stripAdditionalPropertiesFalse are now fully recursive
    schema = flattenSingleVariant(schema);
    schema = stripAdditionalPropertiesFalse(schema);

    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
    const obj = schema as Record<string, unknown>;

    // Ensure `properties` appears before `required` at top level
    let result = hoistKey(obj, "type");
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
