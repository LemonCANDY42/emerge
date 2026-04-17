/**
 * Tool-result projections — declared per-tool / per-agent in the AgentCard.
 *
 * Run server-side BEFORE tool results hit the agent's working memory:
 * strip noise, redact PII, project to schema, cap size, externalize as
 * artifacts. Token-frugality made structural.
 */

import type { ArtifactHandle, SchemaRef } from "./common.js";
import type { ToolName } from "./tool.js";

export interface ToolResultProjection {
  /** Specific tool name or "*" for default catch-all. */
  readonly tool: ToolName | "*";
  readonly steps: readonly ProjectionStep[];
}

export type ProjectionStep =
  | { readonly kind: "redact"; readonly pattern: string; readonly replacement: string }
  | { readonly kind: "project"; readonly toSchema: SchemaRef }
  | { readonly kind: "cap"; readonly maxBytes: number; readonly truncationMessage?: string }
  | {
      readonly kind: "summarize";
      readonly via: "provider" | "rule";
      readonly ref?: string;
    }
  | { readonly kind: "to_handle"; readonly overBytes: number };

/** What a projection chain produces. */
export interface ProjectionOutput {
  readonly preview: string;
  readonly artifact?: ArtifactHandle;
  readonly meta?: Readonly<Record<string, unknown>>;
}
