/**
 * task-loader — parse a Terminal-Bench TaskSpec (YAML/JSON), materialize
 * workspace files, and validate the spec with Zod strict mode.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Result } from "@emerge/kernel/contracts";
import { ScopedTmpdirWorkspaceManager } from "@emerge/workspaces-git-worktree";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ─── TaskSpec Zod schema ──────────────────────────────────────────────────────

const InlineRepoSchema = z.object({ kind: z.literal("inline"), files: z.record(z.string()) });
const GitRepoSchema = z.object({
  kind: z.literal("git"),
  url: z.string().url(),
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
    for: "tbench-loader" as import("@emerge/kernel/contracts").AgentId,
  });
  if (!allocResult.ok) return allocResult;
  const ws = allocResult.value;

  if (spec.repo.kind === "inline") {
    // Write each file into the workspace
    for (const [relPath, content] of Object.entries(spec.repo.files)) {
      const absPath = path.join(ws.root, relPath);
      const dir = path.dirname(absPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(absPath, content, "utf-8");
    }
  } else {
    // Clone the git repo
    try {
      execFileSync("git", ["clone", "--quiet", spec.repo.url, ws.root], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
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
