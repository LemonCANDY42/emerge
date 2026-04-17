/**
 * Tool — a schema + handler + permission descriptor.
 *
 * Tools register with the kernel's ToolRegistry, not with an agent. Agents
 * are granted *subsets* of the registry through their AgentSpec.
 *
 * Token frugality note: tool results return a `ToolResult` with an optional
 * `handle` for large payloads. Agents receive the preview by default; full
 * payloads are fetched lazily through a built-in `read_handle` tool.
 */

import type { AgentId, ContractError, Result, SchemaRef, ToolCallId } from "./common.js";

export type ToolName = string;

export interface ToolSpec {
  readonly name: ToolName;
  readonly description: string;
  /**
   * Standard-Schema-compatible spec for the input (Zod / Valibot / ArkType /
   * etc.). Tools MAY also publish a `jsonSchema` for clients that need raw
   * JSON Schema (e.g. for provider tool-use payloads).
   */
  readonly inputSchema: SchemaRef;
  readonly jsonSchema?: unknown;
  readonly permission: PermissionDescriptor;
  /** Static budget hints used by the scheduler and surveillance. */
  readonly cost?: ToolCostHints;
}

export interface PermissionDescriptor {
  /** Human-readable justification for prompts. */
  readonly rationale: string;
  /** Side-effect classification. */
  readonly effects: readonly ToolEffect[];
  /** "ask" prompts the user; "auto" runs without prompt; "deny" blocks. */
  readonly defaultMode: "ask" | "auto" | "deny";
}

export type ToolEffect =
  | "fs_read"
  | "fs_write"
  | "fs_delete"
  | "net_read"
  | "net_write"
  | "process_spawn"
  | "process_kill"
  | "state_read"
  | "state_write"
  | "agent_spawn"
  | "agent_message";

export interface ToolCostHints {
  readonly p50WallMs?: number;
  readonly p95WallMs?: number;
  readonly tokensOutTypical?: number;
}

export interface ToolInvocation {
  readonly toolCallId: ToolCallId;
  readonly callerAgent: AgentId;
  readonly name: ToolName;
  readonly input: unknown;
  readonly signal?: AbortSignal;
}

/**
 * The result returned to the model. Large payloads SHOULD be referenced via
 * `handle` and previewed with `preview`; the kernel will inject a
 * `read_handle` tool the agent can use to expand on demand.
 */
export interface ToolResult {
  readonly ok: boolean;
  readonly preview: string;
  readonly handle?: string;
  readonly sizeBytes?: number;
  readonly mediaType?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface Tool {
  readonly spec: ToolSpec;
  invoke(call: ToolInvocation): Promise<Result<ToolResult, ContractError>>;
}

/**
 * The registry the kernel owns. Implementations enforce uniqueness on `name`.
 */
export interface ToolRegistry {
  register(tool: Tool): void;
  unregister(name: ToolName): void;
  get(name: ToolName): Tool | undefined;
  /** All tools matching a permission filter and an explicit allow-list. */
  resolve(allow: readonly ToolName[]): readonly Tool[];
  list(): readonly ToolSpec[];
}
