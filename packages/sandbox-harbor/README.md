# @lwrf42/emerge-sandbox-harbor

Docker-backed `Sandbox` implementation for the emerge agent harness.

`HarborSandbox` routes `process_spawn` effects (shell commands) into isolated Docker
containers while handling `fs_read` and `fs_write` effects on the host filesystem.
This provides strong process isolation without requiring agent code changes.

v0.1.0 — early. Real-model verified against `gpt-5.4` with `python:3.12-slim` containers. See [VERIFICATION.md](https://github.com/LemonCANDY42/emerge/blob/main/VERIFICATION.md).

## Install

```bash
npm install @lwrf42/emerge-sandbox-harbor
```

## Usage

```ts
import { HarborSandbox } from "@lwrf42/emerge-sandbox-harbor";
import { makeBashTool, makeFsReadTool, makeFsWriteTool } from "@lwrf42/emerge-tools";

const sandbox = new HarborSandbox({
  workspaceDir: "/path/to/workspace",
  image: "python:3.12-slim",     // Docker image to use (default: ubuntu:22.04)
  networkMode: "none",            // "none" (default) or "bridge"
  memoryMB: 512,                  // container memory limit (default: 512)
  timeoutSeconds: 30,             // per-command timeout (default: 30)
});

// Use with @lwrf42/emerge-tools
kernel.getToolRegistry().register(makeBashTool(sandbox));
kernel.getToolRegistry().register(makeFsReadTool(sandbox));
kernel.getToolRegistry().register(makeFsWriteTool(sandbox));
```

## Effect routing

| Effect | Handler |
|--------|---------|
| `process_spawn` | Runs command in Docker container with workspace bind-mounted to `/workspace` |
| `fs_read` | Passes through to the `run()` callback (host filesystem access) |
| `fs_write` | Passes through to the `run()` callback (host filesystem access) |
| `state_read` | Passes through |
| `state_write` | Passes through |
| `net_read` / `net_write` | Denied unless `networkMode: "bridge"` is set |

## Docker container configuration

Each `process_spawn` call starts a fresh container (`docker run --rm`):

```
docker run --rm
  --network=none           (or --network=bridge)
  --memory=512m
  -v /host/workspace:/workspace
  -w /workspace
  <image>
  bash -c "<command>"
```

The container exits after each command. For tasks with many bash calls, this means
repeated cold-start overhead (~1–3 seconds per command on a warm image cache).

## Constructor options

```ts
interface HarborSandboxOptions {
  /** Host directory to bind-mount at /workspace in the container. */
  workspaceDir: string;
  /** Docker image to use. Default: "ubuntu:22.04". */
  image?: string;
  /** Environment variable names to pass through from the host. Default: []. */
  envAllowlist?: string[];
  /** Container network mode. Default: "none". */
  networkMode?: "none" | "bridge" | "host";
  /** Memory limit in megabytes. Default: 512. */
  memoryMB?: number;
  /** Per-command timeout in seconds. Default: 30. */
  timeoutSeconds?: number;
  /** Optional PermissionPolicy for non-process effects. */
  policy?: PermissionPolicy;
}
```

## Testability

`buildDockerArgv(cmd: string): string[]` is exported for unit testing the Docker
argument construction without invoking docker. See `src/index.test.ts`.

```ts
const argv = sandbox.buildDockerArgv("echo hello");
// ["run", "--rm", "--network=none", "--memory=512m", "-v", "...", "-w", "/workspace", "ubuntu:22.04", "bash", "-c", "echo hello"]
```

Docker-requiring integration tests are gated on `process.env.HAS_DOCKER === "1"`:

```
HAS_DOCKER=1 pnpm test --filter @lwrf42/emerge-sandbox-harbor
```

## Requirements

- Docker CLI must be on `PATH` (`docker` binary)
- Docker daemon must be running
- For macOS: Docker Desktop must be running
- The workspace directory must be accessible to the Docker daemon
  (on macOS, ensure the directory is in Docker Desktop's file sharing settings)
