/**
 * @lwrf42/emerge-sandbox-harbor — Docker-backed Sandbox implementation.
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
 *   - FS effects (fs_read, fs_write) and other non-process_spawn effects run
 *     directly on the host workspace path via the Sandbox.run() callback —
 *     the same isolation as InProcSandbox. HarborSandbox mediates
 *     process_spawn only; net_* effects via direct Sandbox API are not
 *     container-mediated. For full network isolation, configure a
 *     PermissionPolicy that denies net_read and net_write explicitly.
 *   - "ask" policy decisions resolve to "deny" by default (safe for
 *     automated eval). Set askPolicy: "auto-accept" only for trusted,
 *     supervised contexts.
 *
 * Workspace path validation: workspaceDir must be absolute, must exist, and
 * must NOT contain Docker mount-spec separator characters (, : =). This
 * prevents path injection via the --mount spec. Violating these constraints
 * throws at construction time.
 *
 * Requirements: Docker must be installed and running. If the `docker`
 * binary is not found, authorize() returns a clear error and run() never
 * starts a container. See @lwrf42/emerge-sandbox-inproc for a Docker-free option.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ContractError,
  PermissionPolicy,
  Result,
  Sandbox,
  SandboxDecision,
  SandboxRequest,
  ToolEffect,
} from "@lwrf42/emerge-kernel/contracts";

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
  /**
   * How to handle "ask" permission decisions (no interactive terminal in eval).
   * Default: "deny" (safe). Set to "auto-accept" only for trusted, supervised contexts.
   */
  readonly askPolicy?: "auto-accept" | "deny";
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
/**
 * Validate that workspaceDir is safe for use in a Docker --mount spec.
 *
 * Docker mounts use comma/equals as spec separators. A path containing those
 * characters would break the --mount syntax. We also require:
 *   - absolute path (relative paths are ambiguous in spawn context)
 *   - must exist on the host (catches fat-finger errors early)
 *
 * Throws on invalid input so misconfiguration is detected at construction time.
 */
function validateWorkspaceDir(dir: string): void {
  if (!dir || dir.trim() === "") {
    throw new Error("HarborSandbox: workspaceDir must not be empty");
  }
  // Must be absolute
  if (!path.isAbsolute(dir)) {
    throw new Error(`HarborSandbox: workspaceDir must be an absolute path, got: "${dir}"`);
  }
  // Must not contain Docker --mount separator characters: , = :
  // These are the field separators in type=bind,source=...,target=... syntax.
  if (/[,:=]/.test(dir)) {
    throw new Error(
      `HarborSandbox: workspaceDir contains Docker mount-spec separator characters (, : =): "${dir}"`,
    );
  }
  // Must exist (sync stat — constructor cannot be async)
  try {
    fs.statSync(dir);
  } catch {
    throw new Error(`HarborSandbox: workspaceDir does not exist or is not accessible: "${dir}"`);
  }
}

export class HarborSandbox implements Sandbox {
  private readonly image: string;
  private readonly workspaceDir: string;
  private readonly envAllowlist: readonly string[];
  private readonly networkMode: "none" | "bridge";
  private readonly timeoutSeconds: number;
  private readonly memoryMB: number;
  private readonly policy: PermissionPolicy | undefined;
  private readonly askPolicy: "auto-accept" | "deny";
  private readonly dockerDetection: DockerDetection;

  constructor(opts: HarborSandboxOptions) {
    // Validate workspaceDir before storing — rejects injection vectors.
    validateWorkspaceDir(opts.workspaceDir);

    this.image = opts.image ?? "ubuntu:22.04";
    this.workspaceDir = opts.workspaceDir;
    this.envAllowlist = opts.envAllowlist ?? [];
    this.networkMode = opts.networkMode ?? "none";
    this.timeoutSeconds = opts.timeoutSeconds ?? 30;
    this.memoryMB = opts.memoryMB ?? 512;
    this.policy = opts.policy;
    // Safe default: "ask" resolves to deny, not silent auto-accept.
    this.askPolicy = opts.askPolicy ?? "deny";

    this.dockerDetection = detectDocker();
  }

  /**
   * Build the docker run argv for a given shell command.
   * Exported for unit testing without invoking docker.
   *
   * Uses --mount instead of -v to avoid colon-injection: the --mount form uses
   * comma/equals separators whose characters are already banned in workspaceDir
   * by constructor validation. This form also makes the intent explicit.
   */
  buildDockerArgv(cmd: string, opts?: { readonly: boolean }): readonly string[] {
    const readonly = opts?.readonly ?? false;
    const argv: string[] = ["run", "--rm"];

    // Workspace bind-mount using --mount (not -v) to prevent colon-injection.
    // workspaceDir is validated in the constructor to contain no , : = chars.
    const mountSpec = readonly
      ? `type=bind,source=${this.workspaceDir},target=/workspace,readonly`
      : `type=bind,source=${this.workspaceDir},target=/workspace`;
    argv.push("--mount", mountSpec);
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
    // "ask" — honour askPolicy. Default is "deny" (safe for automated eval).
    // Set askPolicy: "auto-accept" in HarborSandboxOptions only for trusted, supervised contexts.
    if (authResult.value.kind === "ask") {
      if (this.askPolicy === "deny") {
        return {
          ok: false,
          error: {
            code: "E_SANDBOX_DENIED",
            message: `effect ${req.effect} requires confirmation but askPolicy is "deny" (no interactive UI)`,
          },
        };
      }
      // askPolicy === "auto-accept": fall through and execute
    }

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
    opts?: { readonly: boolean },
  ): Promise<Result<{ stdout: string; stderr: string; code: number }, ContractError>> {
    // Generate a unique container name so we can kill it on timeout.
    // The name is used with --name and with `docker kill` in the timeout handler.
    const containerName = `emerge-${randomUUID()}`;

    return new Promise((resolve) => {
      const argv = this.buildDockerArgv(cmd, opts);
      // Inject --name so we can target it with docker kill on timeout.
      // Insert after "run" (index 0) so it precedes other flags.
      const argvWithName = [argv[0], "--name", containerName, ...argv.slice(1)] as string[];

      const child = spawn("docker", argvWithName, {
        stdio: ["ignore", "pipe", "pipe"],
        // Do NOT rely on spawn's timeout: it only sends SIGTERM to the docker CLI
        // process, not to the container itself. We implement our own hard timeout below.
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: false,
          error: {
            code: "E_DOCKER_SPAWN",
            message: `Failed to spawn docker: ${String(err)}`,
          },
        });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: true,
          value: {
            stdout,
            stderr,
            code: code ?? 1,
          },
        });
      });

      // Hard timeout: kill the container by name, then SIGKILL the docker CLI.
      // docker kill targets the container; child.kill targets the CLI process.
      // Both are needed because the CLI might have already detached.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Best-effort kill — don't await; fire and forget.
        spawn("docker", ["kill", containerName], { stdio: "ignore" });
        child.kill("SIGKILL");
        resolve({
          ok: false,
          error: {
            code: "E_DOCKER_TIMEOUT",
            message: `Docker container "${containerName}" exceeded timeout of ${this.timeoutSeconds}s and was killed`,
          },
        });
      }, this.timeoutSeconds * 1000);
    });
  }
}
