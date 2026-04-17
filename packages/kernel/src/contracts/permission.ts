/**
 * PermissionPolicy — session-level RBAC granted by the active Mode.
 *
 * Distinct from per-tool `PermissionDescriptor` (which declares what a tool
 * NEEDS). A tool call is allowed iff `descriptor.effects ⊆ policy.allows`.
 *
 * Enforced uniformly at the kernel/sandbox boundary; tools cannot bypass.
 */

import type { ToolName } from "./tool.js";

export type PermScope = "deny" | "ask" | "auto" | { readonly allow: readonly string[] };

export interface PermissionPolicy {
  readonly fs: { readonly read: PermScope; readonly write: PermScope; readonly delete: PermScope };
  readonly net: {
    readonly read: PermScope;
    readonly write: PermScope;
    readonly allowedHosts?: readonly string[];
  };
  readonly process: {
    readonly spawn: PermScope;
    readonly kill: PermScope;
    readonly allowedCmds?: readonly string[];
  };
  readonly agent: { readonly spawn: PermScope; readonly message: PermScope };
  readonly tools: {
    readonly allow: readonly ToolName[] | "all";
    readonly deny?: readonly ToolName[];
  };
  readonly mcp: {
    readonly servers: readonly string[] | "all";
    readonly deny?: readonly string[];
  };
}

export type PermissionCheck =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "ask"; readonly rationale: string };
