/**
 * HarborSandbox unit tests.
 *
 * Docker-requiring tests are gated on process.env.HAS_DOCKER === "1".
 * Unit-level tests verify argv construction without invoking docker.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HarborSandbox } from "./index.js";

// ─── Unit tests (no docker required) ────────────────────────────────────────

describe("HarborSandbox.buildDockerArgv", () => {
  it("includes bind-mount and working directory", () => {
    const sb = new HarborSandbox({ workspaceDir: "/tmp/workspace" });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("-v");
    expect(argv).toContain("/tmp/workspace:/workspace");
    expect(argv).toContain("-w");
    expect(argv).toContain("/workspace");
  });

  it("defaults to ubuntu:22.04 image", () => {
    const sb = new HarborSandbox({ workspaceDir: "/tmp/workspace" });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("ubuntu:22.04");
  });

  it("uses a custom image when specified", () => {
    const sb = new HarborSandbox({ workspaceDir: "/tmp/workspace", image: "python:3.12-slim" });
    const argv = sb.buildDockerArgv("python3 --version");
    expect(argv).toContain("python:3.12-slim");
  });

  it("sets --network=none by default", () => {
    const sb = new HarborSandbox({ workspaceDir: "/tmp/workspace" });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("--network=none");
  });

  it("sets --network=bridge when explicitly specified", () => {
    const sb = new HarborSandbox({ workspaceDir: "/tmp/workspace", networkMode: "bridge" });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("--network=bridge");
  });

  it("sets memory limit", () => {
    const sb = new HarborSandbox({ workspaceDir: "/tmp/workspace", memoryMB: 256 });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("--memory=256m");
  });

  it("uses 512m memory by default", () => {
    const sb = new HarborSandbox({ workspaceDir: "/tmp/workspace" });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("--memory=512m");
  });

  it("includes bash -c wrapper", () => {
    const sb = new HarborSandbox({ workspaceDir: "/tmp/workspace" });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("bash");
    expect(argv).toContain("-c");
    expect(argv).toContain("echo hello");
  });

  it("starts with run --rm", () => {
    const sb = new HarborSandbox({ workspaceDir: "/tmp/workspace" });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv[0]).toBe("run");
    expect(argv[1]).toBe("--rm");
  });
});

// ─── Authorization unit tests ────────────────────────────────────────────────

describe("HarborSandbox.authorize", () => {
  it("allows fs_read by default (no policy)", async () => {
    const sb = new HarborSandbox({ workspaceDir: "/tmp/workspace" });
    const result = await sb.authorize({ effect: "fs_read", target: "/tmp/workspace/foo.txt" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("allow");
    }
  });

  it("allows state_read and state_write", async () => {
    const sb = new HarborSandbox({ workspaceDir: "/tmp/workspace" });
    const r1 = await sb.authorize({ effect: "state_read", target: "some-handle" });
    const r2 = await sb.authorize({ effect: "state_write", target: "some-handle" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok) expect(r1.value.kind).toBe("allow");
    if (r2.ok) expect(r2.value.kind).toBe("allow");
  });
});

// ─── Docker-gated integration tests ─────────────────────────────────────────

// biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature
const hasDocker = process.env["HAS_DOCKER"] === "1";

// Docker container startup can take 30-120s on a cold image cache.
const DOCKER_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDocker)("HarborSandbox (Docker required)", () => {
  it(
    "runs a simple echo command and captures stdout",
    async () => {
      const sb = new HarborSandbox({ workspaceDir: "/tmp" });
      const result = await sb.run({ effect: "process_spawn", target: "echo hello" }, async () => ({
        stdout: "",
        stderr: "",
        code: 0,
      }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as { stdout: string; stderr: string; code: number };
        expect(val.stdout.trim()).toBe("hello");
        expect(val.code).toBe(0);
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  it(
    "captures non-zero exit codes",
    async () => {
      const sb = new HarborSandbox({ workspaceDir: "/tmp" });
      const result = await sb.run({ effect: "process_spawn", target: "exit 42" }, async () => ({
        stdout: "",
        stderr: "",
        code: 0,
      }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as { stdout: string; stderr: string; code: number };
        expect(val.code).toBe(42);
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  it(
    "workspace files are visible inside container",
    async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harbor-test-"));
      await fs.writeFile(path.join(tmpDir, "hello.txt"), "hello from host");

      const sb = new HarborSandbox({ workspaceDir: tmpDir });
      const result = await sb.run(
        { effect: "process_spawn", target: "cat /workspace/hello.txt" },
        async () => ({ stdout: "", stderr: "", code: 0 }),
      );

      await fs.rm(tmpDir, { recursive: true, force: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as { stdout: string; code: number };
        expect(val.stdout.trim()).toBe("hello from host");
        expect(val.code).toBe(0);
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );
});
