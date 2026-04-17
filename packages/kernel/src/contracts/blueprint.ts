/**
 * AgentBlueprint — typed slot composition.
 *
 * Specialized agents are *assembled* from a blueprint + concrete slot
 * bindings, not subclassed. This is "skill-like" plug-and-play but for
 * agent SHAPE itself, not just procedural knowledge.
 */

import type { BlueprintId, SchemaRef } from "./common.js";

export interface AgentBlueprint {
  readonly id: BlueprintId;
  readonly description: string;
  readonly slots: BlueprintSlots;
  /** Anything stable about the assembled spec (system prompt fragments, etc.). */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /** Plug-and-play extension points for proprietary domain capabilities. */
  readonly domainExtensions?: Readonly<Record<string, SlotSpec>>;
}

export interface BlueprintSlots {
  readonly provider: SlotSpec;
  readonly memoryView: SlotSpec;
  readonly tools: SlotSpec;
  readonly surveillance: SlotSpec;
  readonly prompt: SlotSpec;
  readonly behavior?: readonly SlotSpec[];
}

export interface SlotSpec {
  readonly name: string;
  readonly required: boolean;
  /** Schema for what may bind to this slot. */
  readonly accepts: SchemaRef;
  readonly description?: string;
}

export type SlotBindings = Readonly<Record<string, unknown>>;
