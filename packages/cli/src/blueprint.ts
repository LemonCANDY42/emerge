/**
 * Blueprint — YAML-based agent configuration for the CLI.
 *
 * `loadBlueprint(path)` parses and validates a blueprint YAML file, returning
 * a typed `BlueprintConfig` or a structured error. Unknown top-level keys are
 * rejected (Zod strict mode) — this is by design so downstream tools don't
 * silently accept typos.
 *
 * Blueprint schema version: "1.0.0"
 * Document format: docs/cli/blueprint.md
 */

import fs from "node:fs/promises";
import type { Result } from "@lwrf42/emerge-kernel/contracts";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ─── Zod schema ─────────────────────────────────────────────────────────────

const ProviderConfigSchema = z
  .object({
    kind: z.literal("static"),
    providerId: z.string().min(1),
  })
  .strict();

const AgentConfigSchema = z
  .object({
    id: z.string().min(1),
    role: z.string().min(1),
    provider: ProviderConfigSchema,
    tools: z.array(z.string()).default([]),
    system: z.string().optional(),
  })
  .strict();

const ContractConfigSchema = z
  .object({
    id: z.string().min(1),
    goal: z.string().min(1),
  })
  .strict();

const TerminationConfigSchema = z
  .object({
    maxIterations: z.number().int().min(1),
    maxWallMs: z.number().int().min(1),
  })
  .strict();

const VerificationConfigSchema = z
  .object({
    mode: z.enum(["off", "per-step", "on-failure"]),
    requireVerdictBeforeExit: z.boolean().default(false),
  })
  .strict();

export const BlueprintSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    contract: ContractConfigSchema,
    agent: AgentConfigSchema,
    termination: TerminationConfigSchema,
    verification: VerificationConfigSchema.optional(),
    // Default changed to "explicit" to align with kernel.ts:720's own default
    // and to avoid silently bypassing ADR 0012/0035 verdict gates.
    // Blueprints that deliberately want no-adjudicator behaviour must set
    // trustMode: implicit explicitly. See M3c2 review finding #3.
    trustMode: z.enum(["implicit", "explicit"]).default("explicit"),
  })
  .strict();

export type BlueprintConfig = z.infer<typeof BlueprintSchema>;

// ─── Loader ─────────────────────────────────────────────────────────────────

/**
 * Load and validate a blueprint YAML file.
 *
 * Returns `{ ok: false, error }` for:
 *   - File not found / permission error
 *   - Invalid YAML
 *   - Schema version mismatch
 *   - Validation errors (with field paths and messages)
 *   - Unknown top-level keys (strict mode)
 */
export async function loadBlueprint(filePath: string): Promise<Result<BlueprintConfig>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "E_BLUEPRINT_READ",
        message: `Cannot read blueprint file "${filePath}": ${String(err)}`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "E_BLUEPRINT_YAML",
        message: `Invalid YAML in "${filePath}": ${String(err)}`,
      },
    };
  }

  // Fast-check schema version before full validation
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      error: {
        code: "E_BLUEPRINT_FORMAT",
        message: `Blueprint must be a YAML object, got ${typeof parsed}`,
      },
    };
  }

  const obj = parsed as Record<string, unknown>;
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
  if (obj["schemaVersion"] !== "1.0.0") {
    return {
      ok: false,
      error: {
        code: "E_BLUEPRINT_VERSION",
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
        message: `Blueprint schemaVersion must be "1.0.0", got "${String(obj["schemaVersion"])}"`,
      },
    };
  }

  const result = BlueprintSchema.safeParse(parsed);
  if (!result.success) {
    const messages = result.error.issues.map(
      (issue) => `  ${issue.path.join(".")}: ${issue.message}`,
    );
    return {
      ok: false,
      error: {
        code: "E_BLUEPRINT_VALIDATION",
        message: `Blueprint validation failed in "${filePath}":\n${messages.join("\n")}`,
      },
    };
  }

  return { ok: true, value: result.data };
}
