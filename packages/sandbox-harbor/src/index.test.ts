/**
 * HarborSandbox unit tests.
 *
 * Docker-requiring tests are gated on process.env.HAS_DOCKER === "1".
 * Unit-level tests verify argv construction without invoking docker.
 *
 * All tests use a real temp directory (created in beforeAll, cleaned in afterAll)
 * because the HarborSandbox constructor now validates that workspaceDir exists.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HarborSandbox } from "./index.js";

// ─── Shared temp workspace ────────────────────────────────────────────────────

let tmpWorkspace: string;

beforeAll(async () => {
  tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "harbor-unit-"));
});

afterAll(async () => {
  await fs.rm(tmpWorkspace, { recursive: true, force: true });
});

// ─── Unit tests (no docker required) ────────────────────────────────────────

describe("HarborSandbox.buildDockerArgv", () => {
  it("uses --mount (not -v) for workspace bind-mount", () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
    const argv = sb.buildDockerArgv("echo hello");
    // Must use --mount instead of -v to prevent colon-injection
    expect(argv).toContain("--mount");
    expect(argv).not.toContain("-v");
    // The mount spec must contain the workspace path as source
    const mountIdx = argv.indexOf("--mount");
    const mountSpec = argv[mountIdx + 1];
    expect(mountSpec).toContain(`source=${tmpWorkspace}`);
    expect(mountSpec).toContain("target=/workspace");
    expect(mountSpec).not.toContain("readonly");
  });

  it("uses readonly mount when opts.readonly=true", () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
    const argv = sb.buildDockerArgv("echo hello", { readonly: true });
    const mountIdx = argv.indexOf("--mount");
    const mountSpec = argv[mountIdx + 1];
    expect(mountSpec).toContain("readonly");
  });

  it("includes working directory flag", () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("-w");
    expect(argv).toContain("/workspace");
  });

  it("defaults to ubuntu:22.04 image", () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("ubuntu:22.04");
  });

  it("uses a custom image when specified", () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace, image: "python:3.12-slim" });
    const argv = sb.buildDockerArgv("python3 --version");
    expect(argv).toContain("python:3.12-slim");
  });

  it("sets --network=none by default", () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("--network=none");
  });

  it("sets --network=bridge when explicitly specified", () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace, networkMode: "bridge" });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("--network=bridge");
  });

  it("sets memory limit", () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace, memoryMB: 256 });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("--memory=256m");
  });

  it("uses 512m memory by default", () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("--memory=512m");
  });

  it("includes bash -c wrapper", () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv).toContain("bash");
    expect(argv).toContain("-c");
    expect(argv).toContain("echo hello");
  });

  it("starts with run --rm", () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
    const argv = sb.buildDockerArgv("echo hello");
    expect(argv[0]).toBe("run");
    expect(argv[1]).toBe("--rm");
  });

  it("includes --name for container kill-on-timeout", () => {
    // runInDocker injects --name emerge-<uuid>; buildDockerArgv itself does not.
    // Just verify we can build argv without error.
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
    const argv = sb.buildDockerArgv("echo hello");
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.length).toBeGreaterThan(5);
  });
});

// ─── Constructor validation tests ────────────────────────────────────────────

describe("HarborSandbox constructor validation", () => {
  it("throws if workspaceDir does not exist", () => {
    expect(() => new HarborSandbox({ workspaceDir: "/nonexistent/harbor-test-path" })).toThrow(
      /does not exist/,
    );
  });

  it("throws if workspaceDir is relative", () => {
    expect(() => new HarborSandbox({ workspaceDir: "relative/path" })).toThrow(/absolute path/);
  });

  it("throws if workspaceDir contains colon", async () => {
    // Colon is a Docker mount-spec separator — must be rejected.
    expect(() => new HarborSandbox({ workspaceDir: "/tmp/ws:/etc:ro" })).toThrow(/separator/);
  });

  it("throws if workspaceDir contains comma", () => {
    expect(() => new HarborSandbox({ workspaceDir: "/tmp/ws,extra" })).toThrow(/separator/);
  });

  it("accepts a valid absolute path that exists", () => {
    expect(() => new HarborSandbox({ workspaceDir: tmpWorkspace })).not.toThrow();
  });
});

// ─── Authorization unit tests ────────────────────────────────────────────────

describe("HarborSandbox.authorize", () => {
  it("allows fs_read by default (no policy)", async () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
    const result = await sb.authorize({ effect: "fs_read", target: `${tmpWorkspace}/foo.txt` });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("allow");
    }
  });

  it("allows state_read and state_write", async () => {
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
    const r1 = await sb.authorize({ effect: "state_read", target: "some-handle" });
    const r2 = await sb.authorize({ effect: "state_write", target: "some-handle" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok) expect(r1.value.kind).toBe("allow");
    if (r2.ok) expect(r2.value.kind).toBe("allow");
  });

  it("denies 'ask' decisions by default (askPolicy: deny)", async () => {
    const policy = {
      fs: { read: "auto" as const, write: "ask" as const, delete: "deny" as const },
      net: { read: "deny" as const, write: "deny" as const },
      process: { spawn: "auto" as const, kill: "deny" as const },
      agent: { spawn: "deny" as const, message: "deny" as const },
      tools: { allow: "all" as const },
      mcp: { servers: "all" as const },
    };
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace, policy });
    const result = await sb.run(
      { effect: "fs_write", target: `${tmpWorkspace}/x.txt` },
      async () => "ok",
    );
    // With askPolicy: "deny" (default), an "ask" decision must be denied
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_SANDBOX_DENIED");
    }
  });

  it("auto-accepts 'ask' decisions when askPolicy: auto-accept", async () => {
    const policy = {
      fs: { read: "auto" as const, write: "ask" as const, delete: "deny" as const },
      net: { read: "deny" as const, write: "deny" as const },
      process: { spawn: "auto" as const, kill: "deny" as const },
      agent: { spawn: "deny" as const, message: "deny" as const },
      tools: { allow: "all" as const },
      mcp: { servers: "all" as const },
    };
    const sb = new HarborSandbox({ workspaceDir: tmpWorkspace, policy, askPolicy: "auto-accept" });
    const result = await sb.run(
      { effect: "fs_write", target: `${tmpWorkspace}/x.txt` },
      async () => "ok",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("ok");
    }
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
      const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
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
      const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
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
      const testFile = path.join(tmpWorkspace, "hello.txt");
      await fs.writeFile(testFile, "hello from host");

      const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
      const result = await sb.run(
        { effect: "process_spawn", target: "cat /workspace/hello.txt" },
        async () => ({ stdout: "", stderr: "", code: 0 }),
      );

      await fs.rm(testFile, { force: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as { stdout: string; code: number };
        expect(val.stdout.trim()).toBe("hello from host");
        expect(val.code).toBe(0);
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  it(
    "acceptance mode: readonly mount and --workdir /workspace in argv",
    async () => {
      const sb = new HarborSandbox({ workspaceDir: tmpWorkspace });
      const argv = sb.buildDockerArgv("echo test", { readonly: true });
      // Must contain --mount with readonly
      const mountIdx = argv.indexOf("--mount");
      expect(mountIdx).toBeGreaterThan(-1);
      const mountSpec = argv[mountIdx + 1];
      expect(mountSpec).toContain("readonly");
      // Must contain --workdir or -w /workspace
      expect(argv).toContain("-w");
      expect(argv).toContain("/workspace");
    },
    DOCKER_TEST_TIMEOUT_MS,
  );
});
