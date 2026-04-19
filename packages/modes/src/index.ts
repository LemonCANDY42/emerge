/**
 * @lwrf42/emerge-modes — built-in mode registry with 6 default modes.
 */

import type {
  BehaviorConfig,
  Mode,
  ModeName,
  ModeRegistry,
  PermissionPolicy,
  ToolSurface,
} from "@lwrf42/emerge-kernel/contracts";

const fullAuto: PermissionPolicy = {
  fs: { read: "auto", write: "auto", delete: "auto" },
  net: { read: "auto", write: "auto" },
  process: { spawn: "auto", kill: "auto" },
  agent: { spawn: "auto", message: "auto" },
  tools: { allow: "all" },
  mcp: { servers: "all" },
};

const readOnly: PermissionPolicy = {
  fs: { read: "auto", write: "deny", delete: "deny" },
  net: { read: "deny", write: "deny" },
  process: { spawn: "deny", kill: "deny" },
  agent: { spawn: "deny", message: "auto" },
  tools: { allow: "all" },
  mcp: { servers: "all" },
};

const planPolicy: PermissionPolicy = {
  fs: { read: "auto", write: "deny", delete: "deny" },
  net: { read: "auto", write: "deny" },
  process: { spawn: "deny", kill: "deny" },
  agent: { spawn: "deny", message: "auto" },
  tools: { allow: "all" },
  mcp: { servers: "all" },
};

const bypassPolicy: PermissionPolicy = fullAuto;

const acceptEditPolicy: PermissionPolicy = {
  fs: { read: "auto", write: "ask", delete: "ask" },
  net: { read: "auto", write: "ask" },
  process: { spawn: "ask", kill: "deny" },
  agent: { spawn: "ask", message: "auto" },
  tools: { allow: "all" },
  mcp: { servers: "all" },
};

const researchPolicy: PermissionPolicy = {
  fs: { read: "auto", write: "deny", delete: "deny" },
  net: { read: "auto", write: "deny" },
  process: { spawn: "deny", kill: "deny" },
  agent: { spawn: "deny", message: "auto" },
  tools: { allow: "all" },
  mcp: { servers: "all" },
};

const allTools: ToolSurface = { available: [] };
const readOnlyTools: ToolSurface = { available: ["fs.read", "read_handle", "todo_read"] };
const researchTools: ToolSurface = { available: ["fs.read", "read_handle", "todo_read"] };

const behaviorFull: BehaviorConfig = {
  confirmBeforeWrites: false,
  confirmBeforeNetwork: false,
  confirmBeforeSpawn: false,
  autoAccept: true,
  planFirst: false,
  readOnly: false,
};

const behaviorPlan: BehaviorConfig = {
  confirmBeforeWrites: true,
  confirmBeforeNetwork: true,
  confirmBeforeSpawn: true,
  autoAccept: false,
  planFirst: true,
  readOnly: true,
};

const behaviorBypass: BehaviorConfig = {
  confirmBeforeWrites: false,
  confirmBeforeNetwork: false,
  confirmBeforeSpawn: false,
  autoAccept: true,
  planFirst: false,
  readOnly: false,
};

const behaviorAcceptEdit: BehaviorConfig = {
  confirmBeforeWrites: true,
  confirmBeforeNetwork: false,
  confirmBeforeSpawn: true,
  autoAccept: false,
  planFirst: false,
  readOnly: false,
};

const behaviorResearch: BehaviorConfig = {
  confirmBeforeWrites: false,
  confirmBeforeNetwork: false,
  confirmBeforeSpawn: false,
  autoAccept: true,
  planFirst: false,
  readOnly: true,
};

const behaviorRead: BehaviorConfig = {
  confirmBeforeWrites: false,
  confirmBeforeNetwork: false,
  confirmBeforeSpawn: false,
  autoAccept: true,
  planFirst: false,
  readOnly: true,
};

const BUILTINS: readonly Mode[] = [
  {
    name: "auto",
    description: "Full autonomy — everything auto.",
    permissionPolicy: fullAuto,
    toolSurface: allTools,
    behavior: behaviorFull,
  },
  {
    name: "plan",
    description: "Read-only; no writes; human.request for plan approval before exit.",
    permissionPolicy: planPolicy,
    toolSurface: allTools,
    behavior: behaviorPlan,
  },
  {
    name: "bypass",
    description: "Full autonomy + skip all confirmations.",
    permissionPolicy: bypassPolicy,
    toolSurface: allTools,
    behavior: behaviorBypass,
  },
  {
    name: "accept-edit",
    description: "fs.read auto; fs.write/delete requires confirmation.",
    permissionPolicy: acceptEditPolicy,
    toolSurface: allTools,
    behavior: behaviorAcceptEdit,
  },
  {
    name: "research",
    description: "fs.read + net.read auto; no shell; no fs.write.",
    permissionPolicy: researchPolicy,
    toolSurface: researchTools,
    behavior: behaviorResearch,
  },
  {
    name: "read",
    description: "fs.read auto only; net deny; shell deny.",
    permissionPolicy: readOnly,
    toolSurface: readOnlyTools,
    behavior: behaviorRead,
  },
];

export class BuiltinModeRegistry implements ModeRegistry {
  private readonly custom = new Map<ModeName, Mode>();

  builtins(): readonly Mode[] {
    return BUILTINS;
  }

  define(mode: Mode): void {
    this.custom.set(mode.name, mode);
  }

  resolve(name: ModeName): Mode | undefined {
    return this.custom.get(name) ?? BUILTINS.find((m) => m.name === name);
  }

  list(): readonly Mode[] {
    return [...BUILTINS, ...this.custom.values()];
  }
}

/** Convenience: get PermissionPolicy for a named mode (throws on unknown). */
export function permissionPolicyForMode(registry: ModeRegistry, name: ModeName): PermissionPolicy {
  const mode = registry.resolve(name);
  if (!mode) throw new Error(`Unknown mode: ${String(name)}`);
  return mode.permissionPolicy;
}

/**
 * m9: Safe variant that returns Result<PermissionPolicy> instead of throwing.
 * Prefer this in code that handles unknown mode names gracefully.
 */
export function permissionPolicyForModeResult(
  registry: ModeRegistry,
  name: ModeName,
): import("@lwrf42/emerge-kernel/contracts").Result<PermissionPolicy> {
  const mode = registry.resolve(name);
  if (!mode) {
    return {
      ok: false,
      error: { code: "E_UNKNOWN_MODE", message: `Unknown mode: ${String(name)}` },
    };
  }
  return { ok: true, value: mode.permissionPolicy };
}
