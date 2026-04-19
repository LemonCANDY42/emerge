/**
 * Tool name sanitization for OpenAI-compatible APIs.
 *
 * OpenAI's function-call API restricts tool names to ^[a-zA-Z0-9_-]+$
 * (alphanumeric, underscore, hyphen only). Dots, colons, slashes, and
 * other punctuation are illegal and cause 400 / 502 errors from OpenAI-
 * compatible gateways.
 *
 * Emerge tools use dotted names by convention (e.g. "fs.read", "fs.write").
 * This module provides:
 *   - sanitizeToolName: replace dots with underscores, then validate.
 *   - buildToolNameMap: build a per-request wire↔original name map so
 *     incoming function_call events can be reverse-translated before being
 *     emitted to the agent-runner.
 *
 * Important invariants:
 *   - Sanitization is deterministic and idempotent: sanitizeToolName("fs_read")
 *     returns the same wire name as sanitizeToolName("fs.read").
 *   - The reverse map uses the wire name as key and the original name as value.
 *     If two original names collide after sanitization, an error is thrown at
 *     map-build time (not at call time) so failures are caught early.
 *   - No I/O. Pure functions only.
 */

/** Pattern that OpenAI's API considers a valid function name. */
const OPENAI_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Result of sanitizing a single tool name.
 *
 * When `ok` is true, `wire` is the sanitized name safe to send to OpenAI.
 * When `ok` is false, `error` explains why the name cannot be made valid.
 */
export type SanitizeResult =
  | { readonly ok: true; readonly wire: string }
  | { readonly ok: false; readonly wire: string; readonly error: string };

/**
 * Sanitize a single tool name for use on the OpenAI wire format.
 *
 * Steps:
 *   1. Replace every "." with "_".
 *   2. Validate the result matches ^[a-zA-Z0-9_-]+$.
 *      If it still contains illegal characters (e.g. ":", "/", leading digit
 *      is allowed by the regex), return ok=false with a descriptive error.
 *
 * Note: a leading digit IS technically accepted by the regex but the OpenAI
 * API may reject it in practice. We do not add extra logic for digit-leading
 * names — the regex defines the contract.
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
  if (OPENAI_NAME_RE.test(wire)) {
    return { ok: true, wire };
  }

  return {
    ok: false,
    wire,
    error: `Tool name "${name}" cannot be safely sanitized for OpenAI. After replacing "." with "_", the result "${wire}" still contains characters outside [a-zA-Z0-9_-]. Rename the tool to use only alphanumeric characters, underscores, and hyphens.`,
  };
}

/**
 * Bidirectional name map for a single provider request.
 *
 * wireToOriginal: Maps the sanitized (wire) name back to the original tool name,
 *                 so incoming function_call events can be reverse-translated.
 * originalToWire: Maps the original name to the wire name, for building the
 *                 tools array in the API request.
 */
export interface ToolNameMap {
  readonly wireToOriginal: ReadonlyMap<string, string>;
  readonly originalToWire: ReadonlyMap<string, string>;
}

/**
 * Build a per-request bidirectional tool-name map from a list of tool specs.
 *
 * Throws if any tool name cannot be sanitized (illegal characters remain
 * after dot-replacement), or if two different original names would produce
 * the same wire name (collision).
 *
 * The maps are the authoritative source for name translation during a
 * request. Build them once before constructing the API params and pass
 * them to the event-handler loop.
 *
 * @throws Error if sanitization fails or a collision is detected.
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
