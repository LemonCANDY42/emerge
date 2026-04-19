/**
 * Tool name sanitization for Anthropic API.
 *
 * Anthropic's API restricts tool names to ^[a-zA-Z0-9_-]{1,64}$
 * (alphanumeric, underscore, hyphen only, max 64 chars). Dots, colons,
 * slashes, and other punctuation are illegal and cause API errors.
 *
 * Emerge tools use dotted names by convention (e.g. "fs.read", "fs.write").
 * This module provides:
 *   - sanitizeToolName: replace dots with underscores, then validate.
 *   - buildToolNameMap: build a per-request wire↔original name map so
 *     incoming tool_use names can be reverse-translated before being emitted
 *     to the agent-runner.
 *
 * Important invariants:
 *   - Sanitization is deterministic and idempotent.
 *   - The reverse map uses the wire name as key and the original name as value.
 *   - No I/O. Pure functions only.
 */

/** Pattern that Anthropic's API considers a valid tool name. */
const ANTHROPIC_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Result of sanitizing a single tool name.
 *
 * When `ok` is true, `wire` is the sanitized name safe to send to Anthropic.
 * When `ok` is false, `error` explains why the name cannot be made valid.
 */
export type SanitizeResult =
  | { readonly ok: true; readonly wire: string }
  | { readonly ok: false; readonly wire: string; readonly error: string };

/**
 * Sanitize a single tool name for use on the Anthropic wire format.
 *
 * Steps:
 *   1. Replace every "." with "_".
 *   2. Validate the result matches ^[a-zA-Z0-9_-]{1,64}$.
 *      If it still contains illegal characters or exceeds 64 chars,
 *      return ok=false with a descriptive error.
 *
 * @example
 *   sanitizeToolName("fs.read")    // { ok: true, wire: "fs_read" }
 *   sanitizeToolName("fs_read")    // { ok: true, wire: "fs_read" }
 *   sanitizeToolName("bash")       // { ok: true, wire: "bash" }
 *   sanitizeToolName("fs.read.x")  // { ok: true, wire: "fs_read_x" }
 *   sanitizeToolName("tool/x")     // { ok: false, error: "..." }
 *   sanitizeToolName("tool:x")     // { ok: false, error: "..." }
 */
export function sanitizeToolName(name: string): SanitizeResult {
  // Step 1: replace dots with underscores
  const wire = name.replace(/\./g, "_");

  // Step 2: validate
  if (ANTHROPIC_NAME_RE.test(wire)) {
    return { ok: true, wire };
  }

  return {
    ok: false,
    wire,
    error: `Tool name "${name}" cannot be safely sanitized for Anthropic. After replacing "." with "_", the result "${wire}" still contains characters outside [a-zA-Z0-9_-] or exceeds 64 characters. Rename the tool to use only alphanumeric characters, underscores, and hyphens (max 64 chars).`,
  };
}

/**
 * Bidirectional name map for a single provider request.
 */
export interface ToolNameMap {
  readonly wireToOriginal: ReadonlyMap<string, string>;
  readonly originalToWire: ReadonlyMap<string, string>;
}

/**
 * Build a per-request bidirectional tool-name map from a list of tool specs.
 *
 * Throws if any tool name cannot be sanitized, or if two different original
 * names would produce the same wire name (collision).
 */
export function buildToolNameMap(tools: ReadonlyArray<{ name: string }>): ToolNameMap {
  const wireToOriginal = new Map<string, string>();
  const originalToWire = new Map<string, string>();

  for (const tool of tools) {
    const result = sanitizeToolName(tool.name);

    if (!result.ok) {
      throw new Error(result.error);
    }

    // Detect collision: two original names map to the same wire name
    const existingOriginal = wireToOriginal.get(result.wire);
    if (existingOriginal !== undefined && existingOriginal !== tool.name) {
      throw new Error(
        `Tool name collision after sanitization: "${tool.name}" and "${existingOriginal}" both sanitize to "${result.wire}". Rename one of them to avoid the conflict.`,
      );
    }

    wireToOriginal.set(result.wire, tool.name);
    originalToWire.set(tool.name, result.wire);
  }

  return { wireToOriginal, originalToWire };
}
