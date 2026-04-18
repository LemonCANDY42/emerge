/**
 * @emerge/sandbox-harbor — Docker-backed Sandbox implementation.
 *
 * Delegates shell execution to a Docker container. Each run() call for
 * process_spawn effects executes inside a fresh container started from
 * the configured image. The workspace directory is bind-mounted as
 * /workspace so file edits persist to the host.
 *
 * Security model:
 *   - Container isolation via Docker (not a VM; shares the host kernel).
 *   - Network is disabled by default (networkMode: "none").
 *   - Memory is capped (default 512 MB).
 *   - Trust boundary: Docker daemon access implies host root on Linux.
 *     macOS Docker Desktop runs containers in a Linux VM, providing
 *     additional isolation.
 *   - FS effects (fs_read, fs_write) run directly on the host workspace
 *     path — the same isolation as InProcSandbox. Use Docker bind-mount
 *     plus the fs tools for full container-side FS access.
 *
 * Requirements: Docker must be installed and running. If the `docker`
 * binary is not found, authorize() returns a clear error and run() never
 * starts a container. See @emerge/sandbox-inproc for a Docker-free option.
 */

import { execFileSync, spawn } from "node:child_process";
import type {
  ContractError,
  PermissionPolicy,
  Result,
  Sandbox,
  SandboxDecision,
  SandboxRequest,
  ToolEffect,
} from "@emerge/kernel/contracts";

// ─── Options ────────────────────────────────────────────────────────────────

export interface HarborSandboxOptions {
  /** Docker image to run containers from. Default: "ubuntu:22.04" */
  readonly image?: string;
  /** Host path bound as /workspace inside the container. Required. */
  readonly workspaceDir: string;
  /** Env var names whose host values are forwarded to containers. */
  readonly envAllowlist?: readonly string[];
  /** Network mode for containers. Default: "none" (no network). */
  readonly networkMode?: "none" | "bridge";
  /** Per-container wall-clock timeout in seconds. Default: 30. */
  readonly timeoutSeconds?: number;
  /** Container memory cap in MB. Default: 512. */
  readonly memoryMB?: number;
  /** Optional permission policy for non-process effects. */
  readonly policy?: PermissionPolicy;
}

// ─── Docker availability check ───────────────────────────────────────────────

type DockerDetection =
  | { available: true; path: string }
  | { available: false; path: string; error: string };

function detectDocker(): DockerDetection {
  try {
    execFileSync("docker", ["--version"], { encoding: "utf-8", timeout: 5000 });
    return { available: true, path: "docker" };
  } catch (err) {
    return {
      available: false,
      path: "docker",
      error: `docker binary not found or not running: ${String(err)}`,
    };
  }
}

// ─── Permission policy helpers ───────────────────────────────────────────────

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

// ─── HarborSandbox ───────────────────────────────────────────────────────────

/**
 * HarborSandbox — implements the Sandbox contract by delegating
 * process_spawn effects to Docker containers. FS/state effects
 * are mediated by the optional PermissionPolicy (default: allow all).
 */
export class HarborSandbox implements Sandbox {
  private readonly image: string;
  private readonly workspaceDir: string;
  private readonly envAllowlist: readonly string[];
  private readonly networkMode: "none" | "bridge";
  private readonly timeoutSeconds: number;
  private readonly memoryMB: number;
  private readonly policy: PermissionPolicy | undefined;
  private readonly dockerDetection: DockerDetection;

  constructor(opts: HarborSandboxOptions) {
    this.image = opts.image ?? "ubuntu:22.04";
    this.workspaceDir = opts.workspaceDir;
    this.envAllowlist = opts.envAllowlist ?? [];
    this.networkMode = opts.networkMode ?? "none";
    this.timeoutSeconds = opts.timeoutSeconds ?? 30;
    this.memoryMB = opts.memoryMB ?? 512;
    this.policy = opts.policy;

    this.dockerDetection = detectDocker();
  }

  /**
   * Build the docker run argv for a given shell command.
   * Exported for unit testing without invoking docker.
   */
  buildDockerArgv(cmd: string): readonly string[] {
    const argv: string[] = ["run", "--rm"];

    // Workspace bind-mount
    argv.push("-v", `${this.workspaceDir}:/workspace`);
    argv.push("-w", "/workspace");

    // Network
    argv.push(`--network=${this.networkMode}`);

    // Memory
    argv.push(`--memory=${this.memoryMB}m`);

    // Forwarded env vars
    for (const key of this.envAllowlist) {
      const val = process.env[key as string];
      if (val !== undefined) {
        argv.push("-e", `${key}=${val}`);
      }
    }

    // Image + command
    argv.push(this.image, "bash", "-c", cmd);

    return argv;
  }

  async authorize(req: SandboxRequest): Promise<Result<SandboxDecision, ContractError>> {
    // process_spawn always goes to Docker — check docker availability first
    if (req.effect === "process_spawn") {
      if (!this.dockerDetection.available) {
        return {
          ok: true,
          value: {
            kind: "deny",
            reason: `HarborSandbox requires Docker: ${this.dockerDetection.error}`,
          },
        };
      }
      return { ok: true, value: { kind: "allow" } };
    }

    // For other effects, delegate to policy if one is configured
    if (!this.policy) {
      // Default: allow all non-process effects
      return { ok: true, value: { kind: "allow" } };
    }

    const scope = effectToPermScope(req.effect, this.policy);
    if (scope === "deny") {
      return {
        ok: true,
        value: { kind: "deny", reason: `effect ${req.effect} denied by policy` },
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
    // { allow: string[] }
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
    // "ask" auto-accepts (no interactive UI in this implementation)

    // process_spawn: delegate to Docker
    if (req.effect === "process_spawn") {
      return this.runInDocker(req.target) as Promise<Result<T, ContractError>>;
    }

    // All other effects: run fn() directly (same as InProcSandbox)
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

  private runInDocker(
    cmd: string,
  ): Promise<Result<{ stdout: string; stderr: string; code: number }, ContractError>> {
    return new Promise((resolve) => {
      const argv = this.buildDockerArgv(cmd);
      const child = spawn("docker", argv as string[], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.timeoutSeconds * 1000,
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        resolve({
          ok: false,
          error: {
            code: "E_DOCKER_SPAWN",
            message: `Failed to spawn docker: ${String(err)}`,
          },
        });
      });

      child.on("close", (code) => {
        resolve({
          ok: true,
          value: {
            stdout,
            stderr,
            code: code ?? 1,
          },
        });
      });
    });
  }
}
