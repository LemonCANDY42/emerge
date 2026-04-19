/**
 * task-loader — parse a Terminal-Bench TaskSpec (YAML/JSON), materialize
 * workspace files, and validate the spec with Zod strict mode.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Result } from "@lwrf42/emerge-kernel/contracts";
import { ScopedTmpdirWorkspaceManager } from "@lwrf42/emerge-workspaces-git-worktree";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ─── TaskSpec Zod schema ──────────────────────────────────────────────────────

/**
 * Validate that a file key cannot escape the workspace directory.
 * Rejects: absolute paths, path segments containing "..", empty/whitespace keys.
 */
function isSafeRelativePath(key: string): boolean {
  if (key.trim() === "") return false; // empty / whitespace-only
  if (path.isAbsolute(key)) return false; // absolute path
  // Reject any segment that is exactly ".." or starts with ".." followed by a separator
  const segments = key.split(/[/\\]/);
  return !segments.some((seg) => seg === ".." || seg === "...");
}

const SafeFileKeySchema = z.string().min(1).refine(isSafeRelativePath, {
  message:
    "File key must be a safe relative path: no absolute paths, no '..' segments, no empty keys",
});

const InlineRepoSchema = z.object({
  kind: z.literal("inline"),
  files: z.record(SafeFileKeySchema, z.string()),
});
const GitRepoSchema = z.object({
  kind: z.literal("git"),
  // Restrict to https:// and http:// only. file:// and ssh:// allow .gitattributes
  // filter-driver exploits and host filesystem access via git clone.
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u), {
      message: "Git URL must use https:// or http:// scheme (file:// and ssh:// are not allowed)",
    }),
  commit: z.string().min(1),
});

export const TaskSpecSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    repo: z.discriminatedUnion("kind", [InlineRepoSchema, GitRepoSchema]),
    goal: z.string().min(1),
    acceptanceCommand: z.string().min(1),
    timeoutSeconds: z.number().int().min(1).max(3600),
    difficulty: z.enum(["trivial", "small", "medium", "large", "research"]),
  })
  .strict();

export type TaskSpec = z.infer<typeof TaskSpecSchema>;

// ─── Loaded task (spec + resolved workspace) ──────────────────────────────────

export interface LoadedTask {
  readonly spec: TaskSpec;
  /** Absolute path to the workspace root on the host. */
  readonly workspaceRoot: string;
  /** Call this to clean up the workspace when done. */
  cleanup(): Promise<void>;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Parse a TaskSpec from a YAML or JSON string. Returns a validation error
 * with field paths on failure.
 */
export function parseTaskSpec(raw: string, fileName = "<input>"): Result<TaskSpec> {
  let parsed: unknown;
  try {
    // Try YAML first (YAML is a superset of JSON)
    parsed = parseYaml(raw);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "E_TASK_PARSE",
        message: `Cannot parse task spec "${fileName}": ${String(err)}`,
      },
    };
  }

  const result = TaskSpecSchema.safeParse(parsed);
  if (!result.success) {
    const messages = result.error.issues.map(
      (issue) => `  ${issue.path.join(".")}: ${issue.message}`,
    );
    return {
      ok: false,
      error: {
        code: "E_TASK_VALIDATION",
        message: `Task spec validation failed in "${fileName}":\n${messages.join("\n")}`,
      },
    };
  }
  return { ok: true, value: result.data };
}

/**
 * Load a TaskSpec from a YAML/JSON file, then materialize its workspace.
 *
 * For inline repos: writes the files map into a fresh tmpdir workspace.
 * For git repos: clones the repo and checks out the specified commit.
 *
 * Returns a LoadedTask with a cleanup() method — always call it in a
 * finally block to remove the workspace.
 */
export async function loadTask(filePath: string): Promise<Result<LoadedTask>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "E_TASK_READ",
        message: `Cannot read task file "${filePath}": ${String(err)}`,
      },
    };
  }

  const specResult = parseTaskSpec(raw, filePath);
  if (!specResult.ok) return specResult;
  const spec = specResult.value;

  return materializeTask(spec);
}

/**
 * Materialize a TaskSpec into a workspace (can be called directly with
 * an already-parsed spec — used by the smoke tests to avoid round-tripping
 * through the filesystem for inline tasks).
 */
export async function materializeTask(spec: TaskSpec): Promise<Result<LoadedTask>> {
  const mgr = new ScopedTmpdirWorkspaceManager();
  const allocResult = await mgr.allocate({
    for: "tbench-loader" as import("@lwrf42/emerge-kernel/contracts").AgentId,
  });
  if (!allocResult.ok) return allocResult;
  const ws = allocResult.value;

  if (spec.repo.kind === "inline") {
    // Write each file into the workspace.
    // Defense-in-depth: even though Zod already rejected unsafe keys, we
    // re-verify the resolved path is still inside the workspace root. This
    // guards against TOCTOU races or creative Unicode normalization tricks.
    const wsRoot = path.resolve(ws.root);
    for (const [relPath, content] of Object.entries(spec.repo.files)) {
      const absPath = path.resolve(wsRoot, relPath);
      if (!absPath.startsWith(wsRoot + path.sep) && absPath !== wsRoot) {
        await mgr.close(ws.id);
        return {
          ok: false,
          error: {
            code: "E_PATH_ESCAPE",
            message: `File key "${relPath}" resolves outside workspace root (resolved: ${absPath})`,
          },
        };
      }
      const dir = path.dirname(absPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(absPath, content, "utf-8");
    }
  } else {
    // Clone the git repo.
    // Safety flags:
    //   -c protocol.allow=https   — reject non-https submodule/alternate transports
    //   -c filter.*.smudge=cat    — neutralize .gitattributes filter drivers (no exec on checkout)
    //   -c core.symlinks=false    — prevent symlink-based path escapes on checkout
    try {
      execFileSync(
        "git",
        [
          "-c",
          "protocol.allow=https",
          "-c",
          "filter.*.smudge=cat",
          "-c",
          "core.symlinks=false",
          "clone",
          "--quiet",
          spec.repo.url,
          ws.root,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        },
      );
      execFileSync("git", ["checkout", "--quiet", spec.repo.commit], {
        cwd: ws.root,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
    } catch (err) {
      await mgr.close(ws.id);
      return {
        ok: false,
        error: {
          code: "E_TASK_GIT_CLONE",
          message: `Failed to clone repo ${spec.repo.url}@${spec.repo.commit}: ${String(err)}`,
        },
      };
    }
  }

  return {
    ok: true,
    value: {
      spec,
      workspaceRoot: ws.root,
      async cleanup() {
        await mgr.close(ws.id);
      },
    },
  };
}
