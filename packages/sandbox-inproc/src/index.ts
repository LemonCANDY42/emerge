/**
 * InProcSandbox — no actual isolation; authorization checks PermissionPolicy.
 */

import type {
  ContractError,
  PermissionPolicy,
  Result,
  Sandbox,
  SandboxDecision,
  SandboxRequest,
  ToolEffect,
} from "@lwrf42/emerge-kernel/contracts";

function effectToPermScope(
  effect: ToolEffect,
  policy: PermissionPolicy,
): "deny" | "ask" | "auto" | { allow: readonly string[] } {
  switch (effect) {
    case "fs_read":
      return policy.fs.read;
    case "fs_write":
      return policy.fs.write;
    case "fs_delete":
      return policy.fs.delete;
    case "net_read":
      return policy.net.read;
    case "net_write":
      return policy.net.write;
    case "process_spawn":
      return policy.process.spawn;
    case "process_kill":
      return policy.process.kill;
    case "agent_spawn":
      return policy.agent.spawn;
    case "agent_message":
      return policy.agent.message;
    case "state_read":
    case "state_write":
      return "auto";
  }
}

export class InProcSandbox implements Sandbox {
  private readonly policy: PermissionPolicy;

  constructor(policy: PermissionPolicy) {
    this.policy = policy;
  }

  async authorize(req: SandboxRequest): Promise<Result<SandboxDecision, ContractError>> {
    const scope = effectToPermScope(req.effect, this.policy);

    if (scope === "deny") {
      return {
        ok: true,
        value: { kind: "deny", reason: `effect ${req.effect} is denied by active mode policy` },
      };
    }
    if (scope === "ask") {
      return {
        ok: true,
        value: { kind: "ask", rationale: `effect ${req.effect} requires confirmation` },
      };
    }
    if (scope === "auto") {
      return { ok: true, value: { kind: "allow" } };
    }
    // { allow: string[] } — check if target matches
    if (scope.allow.includes(req.target) || scope.allow.includes("*")) {
      return { ok: true, value: { kind: "allow" } };
    }
    return {
      ok: true,
      value: {
        kind: "deny",
        reason: `target ${req.target} not in allowlist for effect ${req.effect}`,
      },
    };
  }

  async run<T>(req: SandboxRequest, fn: () => Promise<T>): Promise<Result<T, ContractError>> {
    const authResult = await this.authorize(req);
    if (!authResult.ok) return authResult;
    if (authResult.value.kind === "deny") {
      return {
        ok: false,
        error: { code: "E_SANDBOX_DENIED", message: authResult.value.reason },
      };
    }
    if (authResult.value.kind === "ask") {
      // In M1 in-proc sandbox, "ask" auto-accepts (no actual UI yet).
      // Real implementations would block and await human approval.
    }
    try {
      return { ok: true, value: await fn() };
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "E_SANDBOX_RUN",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
