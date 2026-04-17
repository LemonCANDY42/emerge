/**
 * BlueprintRegistry + assembleAgent.
 *
 * Blueprints are typed slot definitions for agent shapes. assembleAgent()
 * validates each binding against its slot's `accepts` schema (Standard Schema),
 * merges defaults, and returns a complete AgentSpec.
 *
 * Refuses if:
 *   - Any required slot is unbound.
 *   - Any binding fails schema validation.
 */

import type {
  AgentBlueprint,
  AgentId,
  AgentSpec,
  BlueprintId,
  Budget,
  Result,
  SchemaRef,
  SlotBindings,
} from "@emerge/kernel/contracts";

export class BlueprintRegistry {
  private readonly blueprints = new Map<BlueprintId, AgentBlueprint>();

  register(blueprint: AgentBlueprint): void {
    this.blueprints.set(blueprint.id, blueprint);
  }

  get(id: BlueprintId): AgentBlueprint | undefined {
    return this.blueprints.get(id);
  }

  list(): readonly AgentBlueprint[] {
    return [...this.blueprints.values()];
  }
}

async function validateBinding(value: unknown, schema: SchemaRef): Promise<string | undefined> {
  const result = await schema["~standard"].validate(value);
  if ("issues" in result && result.issues !== undefined && result.issues.length > 0) {
    return result.issues.map((i) => i.message).join("; ");
  }
  return undefined;
}

/**
 * Assemble a complete AgentSpec from a blueprint + bindings.
 *
 * Required slots: provider, memoryView, tools, surveillance, prompt.
 * Optional: behavior slots in blueprint.domainExtensions.
 */
export async function assembleAgent(
  blueprint: AgentBlueprint,
  bindings: SlotBindings,
  agentId: AgentId,
): Promise<Result<AgentSpec>> {
  const { slots, defaults = {} } = blueprint;

  // Validate required slots
  const requiredSlotNames = ["provider", "memoryView", "tools", "surveillance", "prompt"] as const;

  for (const slotName of requiredSlotNames) {
    const slot = slots[slotName];
    if (slot.required && !(slotName in bindings)) {
      return {
        ok: false,
        error: {
          code: "E_MISSING_BINDING",
          message: `Blueprint ${blueprint.id}: required slot '${slotName}' is not bound`,
        },
      };
    }
  }

  // Validate each bound value against its slot schema
  for (const slotName of requiredSlotNames) {
    const slot = slots[slotName];
    const value = bindings[slotName] ?? defaults[slotName];
    if (value === undefined) continue;
    const err = await validateBinding(value, slot.accepts);
    if (err !== undefined) {
      return {
        ok: false,
        error: {
          code: "E_BINDING_INVALID",
          message: `Blueprint ${blueprint.id}: slot '${slotName}' binding failed validation: ${err}`,
        },
      };
    }
  }

  // Also validate domain extensions if present
  if (blueprint.domainExtensions) {
    for (const [extName, extSlot] of Object.entries(blueprint.domainExtensions)) {
      const value = bindings[extName] ?? defaults[extName];
      if (extSlot.required && value === undefined) {
        return {
          ok: false,
          error: {
            code: "E_MISSING_BINDING",
            message: `Blueprint ${blueprint.id}: required domain extension slot '${extName}' is not bound`,
          },
        };
      }
      if (value !== undefined) {
        const err = await validateBinding(value, extSlot.accepts);
        if (err !== undefined) {
          return {
            ok: false,
            error: {
              code: "E_BINDING_INVALID",
              message: `Blueprint ${blueprint.id}: domain extension '${extName}' binding failed: ${err}`,
            },
          };
        }
      }
    }
  }

  // Mn1: validate behavior slots if present
  if (blueprint.slots.behavior) {
    for (const behaviorSlot of blueprint.slots.behavior) {
      const value = bindings[behaviorSlot.name] ?? defaults[behaviorSlot.name];
      if (behaviorSlot.required && value === undefined) {
        return {
          ok: false,
          error: {
            code: "E_MISSING_BINDING",
            message: `Blueprint ${blueprint.id}: required behavior slot '${behaviorSlot.name}' is not bound`,
          },
        };
      }
      if (value !== undefined) {
        const err = await validateBinding(value, behaviorSlot.accepts);
        if (err !== undefined) {
          return {
            ok: false,
            error: {
              code: "E_BINDING_INVALID",
              message: `Blueprint ${blueprint.id}: behavior slot '${behaviorSlot.name}' binding failed: ${err}`,
            },
          };
        }
      }
    }
  }

  // Merge defaults with bindings
  const merged = { ...defaults, ...bindings };

  // Construct AgentSpec from merged bindings
  // The blueprint consumer must provide the shape — we validate, not transform
  // biome-ignore lint/complexity/useLiteralKeys: SlotBindings is Record<string, unknown>, requires bracket access
  const providerBinding = merged["provider"] as AgentSpec["provider"] | undefined;
  // biome-ignore lint/complexity/useLiteralKeys: SlotBindings is Record<string, unknown>, requires bracket access
  const memoryViewBinding = merged["memoryView"] as AgentSpec["memoryView"] | undefined;
  // biome-ignore lint/complexity/useLiteralKeys: SlotBindings is Record<string, unknown>, requires bracket access
  const toolsBinding = merged["tools"] as readonly string[] | undefined;
  // biome-ignore lint/complexity/useLiteralKeys: SlotBindings is Record<string, unknown>, requires bracket access
  const promptBinding = merged["prompt"] as AgentSpec["system"] | undefined;
  // biome-ignore lint/complexity/useLiteralKeys: SlotBindings is Record<string, unknown>, requires bracket access
  const surveillanceBinding = merged["surveillance"] as AgentSpec["surveillance"] | undefined;
  // biome-ignore lint/complexity/useLiteralKeys: SlotBindings is Record<string, unknown>, requires bracket access
  const terminationBinding = merged["termination"] as AgentSpec["termination"] | undefined;
  // biome-ignore lint/complexity/useLiteralKeys: SlotBindings is Record<string, unknown>, requires bracket access
  const budgetBinding = merged["budget"] as Budget | undefined;
  // biome-ignore lint/complexity/useLiteralKeys: SlotBindings is Record<string, unknown>, requires bracket access
  const aclBinding = merged["acl"] as AgentSpec["acl"] | undefined;

  if (!providerBinding) {
    return {
      ok: false,
      error: { code: "E_MISSING_BINDING", message: "provider binding is required" },
    };
  }

  const defaultBudget: Budget = { tokensIn: 10_000, tokensOut: 2_000, wallMs: 60_000, usd: 1.0 };
  const budget = budgetBinding ?? defaultBudget;

  const spec: AgentSpec = {
    id: agentId,
    role: blueprint.id,
    description: blueprint.description,
    provider: providerBinding,
    system: promptBinding ?? { kind: "literal", text: "You are a helpful agent." },
    toolsAllowed: (toolsBinding ?? []) as readonly string[],
    memoryView: memoryViewBinding ?? { inheritFromSupervisor: false, writeTags: [] },
    budget,
    termination: terminationBinding ?? {
      maxIterations: 10,
      maxWallMs: 60_000,
      budget,
      retry: { transient: 3, nonRetryable: 0 },
      cycle: { windowSize: 5, repeatThreshold: 3 },
      done: { kind: "predicate", description: "end_turn" },
    },
    acl: aclBinding ?? {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: (toolsBinding ?? []) as readonly string[],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: true,
      interrupts: true,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
    ...(surveillanceBinding !== undefined ? { surveillance: surveillanceBinding } : {}),
  };

  return { ok: true, value: spec };
}

/**
 * A generic worker blueprint usable for quick demos.
 * Slots: provider (required), memoryView, tools, surveillance, prompt.
 */
export const genericWorkerBlueprint: AgentBlueprint = {
  id: "generic-worker" as BlueprintId,
  description: "A generic stateless worker agent blueprint",
  slots: {
    provider: {
      name: "provider",
      required: true,
      accepts: {
        "~standard": {
          version: 1 as const,
          vendor: "emerge",
          validate: (v) => {
            if (typeof v === "object" && v !== null && "kind" in v) {
              return { value: v };
            }
            return { issues: [{ message: "provider must be an object with a 'kind' field" }] };
          },
        },
      },
      description: "Provider routing spec for this worker",
    },
    memoryView: {
      name: "memoryView",
      required: false,
      accepts: {
        "~standard": {
          version: 1 as const,
          vendor: "emerge",
          validate: (v) => ({ value: v }),
        },
      },
      description: "Memory view spec (optional; defaults to isolated)",
    },
    tools: {
      name: "tools",
      required: false,
      accepts: {
        "~standard": {
          version: 1 as const,
          vendor: "emerge",
          validate: (v) => {
            if (Array.isArray(v)) return { value: v };
            return { issues: [{ message: "tools must be an array" }] };
          },
        },
      },
      description: "Array of tool names this agent may call",
    },
    surveillance: {
      name: "surveillance",
      required: false,
      accepts: {
        "~standard": {
          version: 1 as const,
          vendor: "emerge",
          validate: (v) => ({ value: v }),
        },
      },
      description: "Surveillance profile: off | passive | active | strict",
    },
    prompt: {
      name: "prompt",
      required: false,
      accepts: {
        "~standard": {
          version: 1 as const,
          vendor: "emerge",
          validate: (v) => {
            if (typeof v === "object" && v !== null && "kind" in v) return { value: v };
            return { issues: [{ message: "prompt must be a SystemPrompt object" }] };
          },
        },
      },
      description: "System prompt spec",
    },
  },
  defaults: {
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    tools: [],
    surveillance: "off",
    prompt: { kind: "literal", text: "You are a generic worker agent." },
  },
};
