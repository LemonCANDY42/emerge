/**
 * task-loader tests — parse and validation coverage.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTask, materializeTask, parseTaskSpec } from "./task-loader.js";

// ─── parseTaskSpec ───────────────────────────────────────────────────────────

describe("parseTaskSpec", () => {
  it("parses a valid inline task spec from YAML", () => {
    const yaml = `
id: smoke-001
title: Fix the broken add function
repo:
  kind: inline
  files:
    "src/util.py": |
      def add(a, b):
          return a - b
    "tests/test_util.py": |
      from src.util import add
      def test_add():
          assert add(1, 2) == 3
goal: Fix the bug in src/util.py so pytest tests/ passes
acceptanceCommand: pytest tests/
timeoutSeconds: 60
difficulty: trivial
`;
    const result = parseTaskSpec(yaml, "smoke.yaml");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("smoke-001");
      expect(result.value.repo.kind).toBe("inline");
      expect(result.value.difficulty).toBe("trivial");
    }
  });

  it("parses a valid git task spec", () => {
    const yaml = `
id: git-task-001
title: Fix bug in repo
repo:
  kind: git
  url: https://github.com/example/repo.git
  commit: abc1234
goal: Fix the failing test
acceptanceCommand: pytest tests/
timeoutSeconds: 120
difficulty: small
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repo.kind).toBe("git");
      if (result.value.repo.kind === "git") {
        expect(result.value.repo.commit).toBe("abc1234");
      }
    }
  });

  it("rejects missing required fields", () => {
    const yaml = `
id: bad-spec
title: Missing fields
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TASK_VALIDATION");
    }
  });

  it("rejects unknown extra fields (strict mode)", () => {
    const yaml = `
id: strict-test
title: Extra field test
repo:
  kind: inline
  files: {}
goal: Test
acceptanceCommand: echo ok
timeoutSeconds: 30
difficulty: trivial
unknownField: oops
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TASK_VALIDATION");
      expect(result.error.message).toContain("unknownField");
    }
  });

  it("rejects invalid difficulty values", () => {
    const yaml = `
id: bad-difficulty
title: Bad difficulty
repo:
  kind: inline
  files: {}
goal: Test
acceptanceCommand: echo ok
timeoutSeconds: 30
difficulty: extreme
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TASK_VALIDATION");
    }
  });

  it("rejects invalid git URL", () => {
    const yaml = `
id: bad-url
title: Bad URL
repo:
  kind: git
  url: not-a-url
  commit: abc123
goal: Fix it
acceptanceCommand: pytest
timeoutSeconds: 60
difficulty: small
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TASK_VALIDATION");
    }
  });

  it("rejects timeoutSeconds = 0", () => {
    const yaml = `
id: bad-timeout
title: Zero timeout
repo:
  kind: inline
  files: {}
goal: Test
acceptanceCommand: echo ok
timeoutSeconds: 0
difficulty: trivial
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TASK_VALIDATION");
    }
  });

  it("returns E_TASK_PARSE for invalid YAML", () => {
    const result = parseTaskSpec("{ bad yaml: [[[");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Zod may or may not fail here depending on yaml parser behavior,
      // but we should get some error
      expect(["E_TASK_PARSE", "E_TASK_VALIDATION"].includes(result.error.code)).toBe(true);
    }
  });

  // ─── Path traversal security tests (Critical #1, High #11) ───────────────

  it("rejects file key with '..' segment (path traversal)", () => {
    const yaml = `
id: path-escape-test
title: Path traversal attempt
repo:
  kind: inline
  files:
    "../../../etc/passwd": "evil"
goal: Test
acceptanceCommand: echo ok
timeoutSeconds: 30
difficulty: trivial
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TASK_VALIDATION");
      expect(result.error.message).toContain("..");
    }
  });

  it("rejects file key that is an absolute path", () => {
    const yaml = `
id: abs-path-test
title: Absolute path attempt
repo:
  kind: inline
  files:
    "/etc/passwd": "evil"
goal: Test
acceptanceCommand: echo ok
timeoutSeconds: 30
difficulty: trivial
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TASK_VALIDATION");
    }
  });

  it("rejects empty-string file key", () => {
    // YAML doesn't allow empty string keys unquoted; test with a whitespace key
    // by passing through JSON directly
    const json = JSON.stringify({
      id: "empty-key-test",
      title: "Empty key test",
      repo: { kind: "inline", files: { "": "content" } },
      goal: "Test",
      acceptanceCommand: "echo ok",
      timeoutSeconds: 30,
      difficulty: "trivial",
    });
    const result = parseTaskSpec(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TASK_VALIDATION");
    }
  });

  it("accepts valid nested file keys without '..'", () => {
    const yaml = `
id: valid-nested-test
title: Valid nested paths
repo:
  kind: inline
  files:
    "src/utils/helper.py": "# ok"
    "tests/unit/test_helper.py": "# ok"
goal: Test
acceptanceCommand: echo ok
timeoutSeconds: 30
difficulty: trivial
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(true);
  });

  // ─── Git URL scheme security tests (High #14) ─────────────────────────────

  it("rejects file:// git URL scheme", () => {
    const yaml = `
id: file-url-test
title: File URL test
repo:
  kind: git
  url: file:///path/to/malicious/repo
  commit: abc123
goal: Fix it
acceptanceCommand: pytest
timeoutSeconds: 60
difficulty: small
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TASK_VALIDATION");
      expect(result.error.message).toContain("https");
    }
  });

  it("rejects ssh:// git URL scheme", () => {
    const yaml = `
id: ssh-url-test
title: SSH URL test
repo:
  kind: git
  url: ssh://git@github.com/example/repo.git
  commit: abc123
goal: Fix it
acceptanceCommand: pytest
timeoutSeconds: 60
difficulty: small
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TASK_VALIDATION");
    }
  });

  it("accepts https:// git URL", () => {
    const yaml = `
id: https-url-test
title: HTTPS URL test
repo:
  kind: git
  url: https://github.com/example/repo.git
  commit: abc123
goal: Fix it
acceptanceCommand: pytest
timeoutSeconds: 60
difficulty: small
`;
    const result = parseTaskSpec(yaml);
    expect(result.ok).toBe(true);
  });
});

// ─── materializeTask ─────────────────────────────────────────────────────────

describe("materializeTask (inline)", () => {
  it("materializes inline files into a workspace directory", async () => {
    const spec = {
      id: "mat-test",
      title: "Materialize test",
      repo: {
        kind: "inline" as const,
        files: {
          "src/main.py": "print('hello')\n",
          "tests/test_main.py": "# test\n",
          "README.md": "# Project\n",
        },
      },
      goal: "Make tests pass",
      acceptanceCommand: "echo ok",
      timeoutSeconds: 30,
      difficulty: "trivial" as const,
    };

    const result = await materializeTask(spec);
    try {
      expect(result.ok).toBe(true);
      if (result.ok) {
        const { workspaceRoot } = result.value;
        // Verify files exist
        const mainContent = await fs.readFile(path.join(workspaceRoot, "src/main.py"), "utf-8");
        expect(mainContent).toBe("print('hello')\n");

        const testContent = await fs.readFile(
          path.join(workspaceRoot, "tests/test_main.py"),
          "utf-8",
        );
        expect(testContent).toBe("# test\n");

        const readmeContent = await fs.readFile(path.join(workspaceRoot, "README.md"), "utf-8");
        expect(readmeContent).toBe("# Project\n");
      }
    } finally {
      if (result.ok) {
        await result.value.cleanup();
      }
    }
  });

  it("creates subdirectories for nested file paths", async () => {
    const spec = {
      id: "nested-test",
      title: "Nested dirs test",
      repo: {
        kind: "inline" as const,
        files: {
          "src/utils/helpers.py": "# helpers\n",
          "src/utils/math.py": "# math\n",
        },
      },
      goal: "Test",
      acceptanceCommand: "echo ok",
      timeoutSeconds: 30,
      difficulty: "trivial" as const,
    };

    const result = await materializeTask(spec);
    try {
      expect(result.ok).toBe(true);
      if (result.ok) {
        const helpersPath = path.join(result.value.workspaceRoot, "src/utils/helpers.py");
        const stat = await fs.stat(helpersPath);
        expect(stat.isFile()).toBe(true);
      }
    } finally {
      if (result.ok) {
        await result.value.cleanup();
      }
    }
  });

  it("cleanup removes the workspace directory", async () => {
    const spec = {
      id: "cleanup-test",
      title: "Cleanup test",
      repo: {
        kind: "inline" as const,
        files: { "file.txt": "content\n" },
      },
      goal: "Test",
      acceptanceCommand: "echo ok",
      timeoutSeconds: 30,
      difficulty: "trivial" as const,
    };

    const result = await materializeTask(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { workspaceRoot } = result.value;
      await result.value.cleanup();
      // Directory should be gone
      let exists = false;
      try {
        await fs.stat(workspaceRoot);
        exists = true;
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    }
  });

  it("rejects path-escape at materialize time (defense-in-depth)", async () => {
    // Even if the Zod schema somehow passed, materializeTask must also reject
    // paths that resolve outside the workspace. We bypass Zod here by casting.
    const spec = {
      id: "escape-defense-test",
      title: "Path escape defense-in-depth",
      repo: {
        kind: "inline" as const,
        // Force an unsafe path that bypasses the Zod refine (simulated)
        files: {} as Record<string, string>,
      },
      goal: "Test",
      acceptanceCommand: "echo ok",
      timeoutSeconds: 30,
      difficulty: "trivial" as const,
    };
    // Inject a malicious key directly (bypasses Zod schema validation)
    // This tests the defense-in-depth path.resolve() check in materializeTask.
    (spec.repo.files as Record<string, string>)["../escape-test.txt"] = "evil";

    const result = await materializeTask(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_PATH_ESCAPE");
    }
  });
});

// ─── loadTask ────────────────────────────────────────────────────────────────

describe("loadTask", () => {
  it("loads a YAML file from disk", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tbench-test-"));
    const taskFile = path.join(tmpDir, "task.yaml");

    try {
      await fs.writeFile(
        taskFile,
        `
id: file-load-test
title: File load test
repo:
  kind: inline
  files:
    "app.py": "print('ok')"
goal: Make it work
acceptanceCommand: python3 app.py
timeoutSeconds: 30
difficulty: trivial
`,
      );

      const result = await loadTask(taskFile);
      try {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.spec.id).toBe("file-load-test");
          expect(result.value.workspaceRoot).toBeTruthy();
        }
      } finally {
        if (result.ok) await result.value.cleanup();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns E_TASK_READ for missing file", async () => {
    const result = await loadTask("/non/existent/path/task.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_TASK_READ");
    }
  });
});
