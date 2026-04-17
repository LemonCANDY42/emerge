/**
 * @emerge/tools — built-in tools using sandbox for permission gating.
 */

import { exec } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import type {
  ArtifactHandle,
  ArtifactStore,
  ContractError,
  Result,
  Sandbox,
  Tool,
  ToolInvocation,
  ToolResult,
} from "@emerge/kernel/contracts";
import { z } from "zod";

void createReadStream;
void createWriteStream;

const execAsync = promisify(exec);

// Zod 3.24 conforms to StandardSchema v1 structurally, but TS's strict
// exactOptionalPropertyTypes catches a mismatch in the failure branch shape.
// Cast through unknown rather than weaken the function signature.
function zodToSchemaRef<T extends z.ZodTypeAny>(
  schema: T,
): import("@emerge/kernel/contracts").SchemaRef {
  return schema as unknown as import("@emerge/kernel/contracts").SchemaRef;
}

// --- fs.read ---

const fsReadSchema = z.object({ path: z.string() });

export function makeFsReadTool(sandbox: Sandbox): Tool {
  return {
    spec: {
      name: "fs.read",
      description: "Read the contents of a file at the given path.",
      inputSchema: zodToSchemaRef(fsReadSchema),
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute or relative file path" } },
        required: ["path"],
      },
      permission: {
        rationale: "Read file contents from the filesystem",
        effects: ["fs_read"],
        defaultMode: "auto",
      },
    },
    async invoke(call: ToolInvocation): Promise<Result<ToolResult, ContractError>> {
      const parsed = fsReadSchema.safeParse(call.input);
      if (!parsed.success) {
        return { ok: false, error: { code: "E_INPUT", message: parsed.error.message } };
      }
      const result = await sandbox.run({ effect: "fs_read", target: parsed.data.path }, async () =>
        fs.readFile(parsed.data.path, "utf-8"),
      );
      if (!result.ok) return result;
      const text = result.value;
      const preview = text.slice(0, 2000) + (text.length > 2000 ? "\n...[truncated]" : "");
      return {
        ok: true,
        value: {
          ok: true,
          preview,
          sizeBytes: text.length,
          mediaType: "text/plain",
        },
      };
    },
  };
}

// --- fs.write ---

const fsWriteSchema = z.object({ path: z.string(), content: z.string() });

export function makeFsWriteTool(sandbox: Sandbox): Tool {
  return {
    spec: {
      name: "fs.write",
      description: "Write content to a file at the given path.",
      inputSchema: zodToSchemaRef(fsWriteSchema),
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["path", "content"],
      },
      permission: {
        rationale: "Write content to a file",
        effects: ["fs_write"],
        defaultMode: "ask",
      },
    },
    async invoke(call: ToolInvocation): Promise<Result<ToolResult, ContractError>> {
      const parsed = fsWriteSchema.safeParse(call.input);
      if (!parsed.success) {
        return { ok: false, error: { code: "E_INPUT", message: parsed.error.message } };
      }
      const result = await sandbox.run(
        { effect: "fs_write", target: parsed.data.path },
        async () => {
          const dir = parsed.data.path.replace(/\/[^/]+$/, "");
          if (dir && dir !== parsed.data.path) {
            await fs.mkdir(dir, { recursive: true });
          }
          await fs.writeFile(parsed.data.path, parsed.data.content, "utf-8");
        },
      );
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          ok: true,
          preview: `Written ${parsed.data.content.length} bytes to ${parsed.data.path}`,
          sizeBytes: parsed.data.content.length,
          mediaType: "application/json",
        },
      };
    },
  };
}

// --- bash ---

const bashSchema = z.object({
  cmd: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
});

export function makeBashTool(sandbox: Sandbox): Tool {
  return {
    spec: {
      name: "bash",
      description: "Execute a shell command. Returns stdout, stderr, and exit code.",
      inputSchema: zodToSchemaRef(bashSchema),
      jsonSchema: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "Shell command to execute" },
          cwd: { type: "string", description: "Working directory" },
          timeoutMs: { type: "number", description: "Timeout in milliseconds" },
        },
        required: ["cmd"],
      },
      permission: {
        rationale: "Execute shell commands",
        // M10: bash can run curl/wget/etc., so net_read and net_write are included.
        effects: ["process_spawn", "fs_read", "fs_write", "net_read", "net_write"],
        defaultMode: "ask",
      },
    },
    async invoke(call: ToolInvocation): Promise<Result<ToolResult, ContractError>> {
      const parsed = bashSchema.safeParse(call.input);
      if (!parsed.success) {
        return { ok: false, error: { code: "E_INPUT", message: parsed.error.message } };
      }
      const { cmd, cwd, timeoutMs } = parsed.data;
      // M11: pass the full cmd string as the sandbox target (not just the first
      // token) so allowlist matchers can operate on the entire command string.
      // InProcSandbox's allowlist semantics: match against the full command string.
      // Users needing fine-grained allowlists should use regex matchers.
      const result = await sandbox.run({ effect: "process_spawn", target: cmd }, async () => {
        try {
          const { stdout, stderr } = await execAsync(cmd, {
            cwd,
            timeout: timeoutMs ?? 30_000,
            maxBuffer: 1024 * 1024,
          });
          return { stdout, stderr, code: 0 };
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; code?: number };
          return {
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? String(err),
            code: e.code ?? 1,
          };
        }
      });
      if (!result.ok) return result;
      const { stdout, stderr, code } = result.value;
      const preview = [
        stdout ? `stdout:\n${stdout.slice(0, 1000)}` : "",
        stderr ? `stderr:\n${stderr.slice(0, 500)}` : "",
        `exit: ${code}`,
      ]
        .filter(Boolean)
        .join("\n");

      return {
        ok: true,
        value: {
          ok: code === 0,
          preview,
          meta: { stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 1024), code },
        },
      };
    },
  };
}

// --- read_handle ---

const readHandleSchema = z.object({ handle: z.string() });

export function makeReadHandleTool(sandbox: Sandbox, store: ArtifactStore): Tool {
  return {
    spec: {
      name: "read_handle",
      description: "Read the full content of an artifact by its handle.",
      inputSchema: zodToSchemaRef(readHandleSchema),
      jsonSchema: {
        type: "object",
        properties: {
          handle: {
            type: "string",
            description: "Artifact handle returned by a previous tool call",
          },
        },
        required: ["handle"],
      },
      permission: {
        rationale: "Read artifact content by handle",
        effects: ["state_read"],
        defaultMode: "auto",
      },
    },
    async invoke(call: ToolInvocation): Promise<Result<ToolResult, ContractError>> {
      const parsed = readHandleSchema.safeParse(call.input);
      if (!parsed.success) {
        return { ok: false, error: { code: "E_INPUT", message: parsed.error.message } };
      }
      const result = await sandbox.run(
        { effect: "state_read", target: parsed.data.handle },
        async () => store.get(parsed.data.handle as ArtifactHandle),
      );
      if (!result.ok) return result;
      const artifact = result.value;
      if (!artifact.ok) {
        return {
          ok: false,
          error: { code: "E_NOT_FOUND", message: `handle ${parsed.data.handle} not found` },
        };
      }
      const bytes = await artifact.value.bytes();
      const text = new TextDecoder().decode(bytes);
      return {
        ok: true,
        value: {
          ok: true,
          preview: text.slice(0, 2000) + (text.length > 2000 ? "\n...[truncated]" : ""),
          sizeBytes: bytes.length,
          mediaType: artifact.value.meta.mediaType,
        },
      };
    },
  };
}

// --- todo_write / todo_read ---

const todoWriteSchema = z.object({
  items: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean().optional() })),
});
const todoReadSchema = z.object({});

const todoStore = new Map<string, { id: string; text: string; done: boolean }>();

export function makeTodoWriteTool(sandbox: Sandbox): Tool {
  return {
    spec: {
      name: "todo_write",
      description: "Write todo items to the in-process store.",
      inputSchema: zodToSchemaRef(todoWriteSchema),
      jsonSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                done: { type: "boolean" },
              },
              required: ["id", "text"],
            },
          },
        },
        required: ["items"],
      },
      permission: {
        rationale: "Write todo items to memory",
        effects: ["state_write"],
        defaultMode: "auto",
      },
    },
    async invoke(call: ToolInvocation): Promise<Result<ToolResult, ContractError>> {
      const parsed = todoWriteSchema.safeParse(call.input);
      if (!parsed.success) {
        return { ok: false, error: { code: "E_INPUT", message: parsed.error.message } };
      }
      const result = await sandbox.run({ effect: "state_write", target: "todo" }, async () => {
        for (const item of parsed.data.items) {
          todoStore.set(item.id, { id: item.id, text: item.text, done: item.done ?? false });
        }
      });
      if (!result.ok) return result;
      return { ok: true, value: { ok: true, preview: `Wrote ${parsed.data.items.length} items` } };
    },
  };
}

export function makeTodoReadTool(sandbox: Sandbox): Tool {
  return {
    spec: {
      name: "todo_read",
      description: "Read all todo items from the in-process store.",
      inputSchema: zodToSchemaRef(todoReadSchema),
      jsonSchema: { type: "object", properties: {} },
      permission: {
        rationale: "Read todo items from memory",
        effects: ["state_read"],
        defaultMode: "auto",
      },
    },
    async invoke(call: ToolInvocation): Promise<Result<ToolResult, ContractError>> {
      void call;
      const result = await sandbox.run({ effect: "state_read", target: "todo" }, async () => [
        ...todoStore.values(),
      ]);
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          ok: true,
          preview: JSON.stringify(result.value, null, 2),
          mediaType: "application/json",
        },
      };
    },
  };
}
