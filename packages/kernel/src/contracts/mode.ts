/**
 * Operating modes — composable policy triples.
 *
 * Mode = (PermissionPolicy, ToolSurface, BehaviorConfig).
 * Built-ins: auto / plan / bypass / accept-edit / research / read.
 * Custom modes pluggable through ModeRegistry.
 */

import type { PermissionPolicy } from "./permission.js";
import type { ToolResultProjection } from "./projection.js";
import type { ToolName } from "./tool.js";

export type ModeName =
  | "auto"
  | "plan"
  | "bypass"
  | "accept-edit"
  | "research"
  | "read"
  | (string & {});

export interface Mode {
  readonly name: ModeName;
  readonly description?: string;
  readonly permissionPolicy: PermissionPolicy;
  readonly toolSurface: ToolSurface;
  readonly behavior: BehaviorConfig;
}

export interface ToolSurface {
  /** Tools available in this mode (resolved from the registry). */
  readonly available: readonly ToolName[];
  /** Optional projections applied to tool results in this mode. */
  readonly projections?: readonly ToolResultProjection[];
  /** MCP servers exposed in this mode. */
  readonly mcpServers?: readonly string[];
}

export interface BehaviorConfig {
  readonly confirmBeforeWrites: boolean;
  readonly confirmBeforeNetwork: boolean;
  readonly confirmBeforeSpawn: boolean;
  readonly autoAccept: boolean;
  readonly planFirst: boolean;
  readonly readOnly: boolean;
  /** Extension keys for custom mode behavior. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface ModeRegistry {
  builtins(): readonly Mode[];
  define(mode: Mode): void;
  resolve(name: ModeName): Mode | undefined;
  list(): readonly Mode[];
}
