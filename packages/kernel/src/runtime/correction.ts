/**
 * correction.ts — Pre-dispatch tool-call correction layer (ADR 0034).
 *
 * A pure, framework-agnostic function that applies lightweight heuristics to
 * fix common LLM tool-call mistakes before dispatch. Each heuristic is
 * documented inline. The function never silently corrupts: if a heuristic
 * cannot safely apply, the field is left unchanged.
 *
 * Heuristics implemented (start small — add only when evidence supports):
 *
 *   type-coerce      — spec says "number" or "boolean", model sent a string
 *                      ("42" → 42, "true" → true). Safe only when the string
 *                      round-trips identically after coercion.
 *
 *   default-fill     — spec property is optional with a JSON Schema "default",
 *                      property is absent in the call input → fill with default.
 *
 *   string-unescape  — spec says "object" or "array", model sent a JSON string
 *                      → JSON.parse and substitute. Falls back to original on
 *                      parse failure or if result type mismatches.
 */

import type { ToolInvocation } from "../contracts/tool.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FixKind = "type-coerce" | "default-fill" | "string-unescape" | "string-parse-json";

export interface Fix {
  readonly kind: FixKind;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface CorrectionResult {
  readonly call: ToolInvocation;
  readonly fixes: readonly Fix[];
}

/**
 * Minimal subset of a JSON Schema property descriptor that the corrector
 * reads. We only access what we need; unknown keys are ignored.
 */
interface JsonSchemaProp {
  type?: string | readonly string[];
  default?: unknown;
}

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProp>;
  required?: readonly string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely extract the jsonSchema as a JsonSchemaObject.
 * Returns undefined if the spec does not carry a usable object schema.
 */
function asObjectSchema(jsonSchema: unknown): JsonSchemaObject | undefined {
  if (jsonSchema === null || typeof jsonSchema !== "object" || Array.isArray(jsonSchema)) {
    return undefined;
  }
  // Cast early so property accesses avoid the index-signature restriction.
  const s = jsonSchema as JsonSchemaObject;
  // We only correct top-level fields — only "object" schemas have properties.
  // Allow schemas that omit "type" — some providers strip it.
  // (No early-return for type mismatch: we rely on the properties check below.)
  if (typeof s.properties !== "object" || s.properties === null) {
    return undefined;
  }
  return s;
}

/**
 * Extract the first string type from a JSON Schema "type" field.
 * Handles both string and string[] forms.
 */
function primaryType(prop: JsonSchemaProp): string | undefined {
  const t = prop.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    // Filter out "null" and return the first concrete type.
    const concrete = (t as string[]).filter((v) => v !== "null");
    return concrete[0];
  }
  return undefined;
}

/**
 * Return a plain object copy of the call's input with the given field replaced.
 * Input is cast to Record<string, unknown>; caller must already have verified
 * that input is an object.
 */
function patchInput(
  input: Record<string, unknown>,
  field: string,
  value: unknown,
): Record<string, unknown> {
  return { ...input, [field]: value };
}

// ---------------------------------------------------------------------------
// Individual heuristic appliers
// ---------------------------------------------------------------------------

/**
 * type-coerce: spec says "number" or "boolean", model sent a string.
 * Applied only when the string round-trips safely.
 */
function applyTypeCoerce(
  field: string,
  value: unknown,
  prop: JsonSchemaProp,
  fixes: Fix[],
): unknown {
  const pt = primaryType(prop);
  if (typeof value !== "string") return value;

  if (pt === "number") {
    const coerced = Number(value);
    // Round-trip check: the coerced number must stringify back to the same string.
    if (!Number.isNaN(coerced) && String(coerced) === value) {
      fixes.push({ kind: "type-coerce", field, before: value, after: coerced });
      return coerced;
    }
    return value;
  }

  if (pt === "boolean") {
    const lower = value.toLowerCase();
    if (lower === "true") {
      fixes.push({ kind: "type-coerce", field, before: value, after: true });
      return true;
    }
    if (lower === "false") {
      fixes.push({ kind: "type-coerce", field, before: value, after: false });
      return false;
    }
    return value;
  }

  return value;
}

/**
 * string-unescape: spec says "object" or "array", model sent a JSON string.
 * Parses and substitutes only when the parsed result matches the expected type.
 */
function applyStringUnescape(
  field: string,
  value: unknown,
  prop: JsonSchemaProp,
  fixes: Fix[],
): unknown {
  const pt = primaryType(prop);
  if (pt !== "object" && pt !== "array") return value;
  if (typeof value !== "string") return value;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Unparseable — leave unchanged.
    return value;
  }

  const parsedIsObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const parsedIsArray = Array.isArray(parsed);

  if (pt === "object" && parsedIsObject) {
    fixes.push({ kind: "string-unescape", field, before: value, after: parsed });
    return parsed;
  }
  if (pt === "array" && parsedIsArray) {
    fixes.push({ kind: "string-unescape", field, before: value, after: parsed });
    return parsed;
  }

  // Type mismatch (e.g. string parses to an array but spec wants object) — leave unchanged.
  return value;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * correctToolCall — apply all heuristics to a ToolInvocation given a tool's
 * JSON schema. Returns the (possibly mutated) call and the list of fixes applied.
 *
 * The function is pure: it never mutates its arguments. If no corrections are
 * possible, it returns the original call reference unchanged (zero allocation).
 */
export function correctToolCall(
  call: ToolInvocation,
  /**
   * The tool's jsonSchema field (from ToolSpec). May be undefined if the tool
   * was registered without a jsonSchema — in that case no corrections are applied.
   */
  jsonSchema: unknown,
): CorrectionResult {
  const schema = asObjectSchema(jsonSchema);

  // No schema → nothing to correct.
  if (!schema || typeof schema.properties !== "object") {
    return { call, fixes: [] };
  }

  const input = call.input;

  // We only correct plain object inputs.
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { call, fixes: [] };
  }

  const inputObj = input as Record<string, unknown>;
  const fixes: Fix[] = [];
  let patched = inputObj;

  const properties = schema.properties as Record<string, JsonSchemaProp>;

  for (const [field, prop] of Object.entries(properties)) {
    const current = patched[field];

    if (current === undefined) {
      // default-fill: property is missing and schema declares a default.
      if (Object.prototype.hasOwnProperty.call(prop, "default")) {
        const def = prop.default;
        fixes.push({ kind: "default-fill", field, before: undefined, after: def });
        patched = patchInput(patched, field, def);
      }
      // No further heuristics apply to missing fields.
      continue;
    }

    // type-coerce: try to fix wrong primitive type.
    const afterCoerce = applyTypeCoerce(field, current, prop, fixes);
    if (afterCoerce !== current) {
      patched = patchInput(patched, field, afterCoerce);
      continue; // Don't double-apply to the same field.
    }

    // string-unescape: try to fix JSON-as-string for object/array fields.
    const afterUnescape = applyStringUnescape(field, current, prop, fixes);
    if (afterUnescape !== current) {
      patched = patchInput(patched, field, afterUnescape);
    }
  }

  // If nothing changed, return the original call reference (zero allocation).
  if (fixes.length === 0) {
    return { call, fixes: [] };
  }

  const correctedCall: ToolInvocation = { ...call, input: patched };
  return { call: correctedCall, fixes };
}
