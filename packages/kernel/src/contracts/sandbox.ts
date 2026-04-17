/**
 * Sandbox — execution boundary for tool side-effects (filesystem, network,
 * processes). Pluggable: in-process (no isolation), container, microVM.
 *
 * The kernel asks the sandbox to mediate any tool effect declared in
 * PermissionDescriptor.effects.
 */

import type { ContractError, Result } from "./common.js";
import type { ToolEffect } from "./tool.js";

export interface SandboxRequest {
  readonly effect: ToolEffect;
  /** Resource the tool wants to touch (path, host, pid, etc.). */
  readonly target: string;
  /** Free-form additional context for policy decisions. */
  readonly context?: Readonly<Record<string, string>>;
}

export type SandboxDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; rationale: string };

export interface Sandbox {
  /**
   * Pre-flight policy check. The kernel calls this before the tool runs;
   * "ask" decisions are surfaced to the user (or a policy provider).
   */
  authorize(req: SandboxRequest): Promise<Result<SandboxDecision, ContractError>>;

  /**
   * Run a function inside the sandbox. The default in-process implementation
   * just invokes `fn`; real sandboxes serialize state across the boundary.
   */
  run<T>(req: SandboxRequest, fn: () => Promise<T>): Promise<Result<T, ContractError>>;
}
