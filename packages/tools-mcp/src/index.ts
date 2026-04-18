/**
 * @emerge/tools-mcp — MCP client that wraps MCP servers as emerge Tool instances.
 *
 * McpToolRegistry connects to one or more MCP servers (stdio or HTTP transport),
 * discovers their tools via `tools/list`, and registers each as an emerge Tool
 * with name-mangled `mcp__${serverName}__${toolName}` to avoid collisions.
 *
 * Conservative permission defaults: `{ defaultMode: "ask", effects: ["state_read", "state_write"] }`
 * because MCP servers are external processes — we cannot know their side-effects
 * without explicit declaration. See ADR 0031 rationale.
 */

import type {
  ContractError,
  PermissionDescriptor,
  Result,
  Sandbox,
  SchemaRef,
  Tool,
  ToolInvocation,
  ToolRegistry,
  ToolResult,
  ToolSpec,
} from "@emerge/kernel/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// ---- McpServerConfig discriminated union ----

export type McpServerConfig =
  | {
      readonly kind: "stdio";
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "http";
      readonly name: string;
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

// ---- Internal types ----

interface ServerConnection {
  readonly config: McpServerConfig;
  readonly client: Client;
  readonly transport: Transport;
}

// ---- Default permission heuristic ----

/**
 * Derive a conservative PermissionDescriptor for an MCP-backed tool.
 *
 * If the tool description contains keywords hinting at pure reads (query, list,
 * fetch, get, read, search) and no write keywords, downgrade to "auto". Otherwise
 * default to "ask" with both state_read and state_write effects. This is intentionally
 * conservative — MCP servers are external processes with unknown side-effects.
 */
function derivePermission(toolDescription: string): PermissionDescriptor {
  const lower = toolDescription.toLowerCase();
  const hasWriteHint = /\b(write|create|delete|remove|update|modify|send|post|put|patch)\b/.test(
    lower,
  );
  const hasReadOnlyHint =
    !hasWriteHint && /\b(read|list|get|fetch|query|search|show|describe|inspect)\b/.test(lower);

  if (hasReadOnlyHint) {
    return {
      rationale: "MCP tool (read-inferred from description)",
      effects: ["state_read"],
      defaultMode: "auto",
    };
  }

  return {
    rationale:
      "MCP tool — conservative default: side-effects unknown for external server. Review before setting to 'auto'.",
    effects: ["state_read", "state_write"],
    defaultMode: "ask",
  };
}

// ---- Minimal pass-through SchemaRef ----

function makePassthroughSchemaRef(): SchemaRef {
  return {
    "~standard": {
      version: 1,
      vendor: "emerge-mcp",
      validate: (v) => ({ value: v }),
    },
  };
}

// ---- McpToolRegistry ----

export interface McpToolRegistryConfig {
  readonly servers: readonly McpServerConfig[];
  readonly sandbox: Sandbox;
  readonly defaultPermission?: PermissionDescriptor;
}

/**
 * Connects to MCP servers, discovers tools, and registers them in the
 * provided ToolRegistry. Call `connect()` to initialize.
 */
export class McpToolRegistry {
  private readonly config: McpToolRegistryConfig;
  private readonly connections: ServerConnection[] = [];

  constructor(config: McpToolRegistryConfig) {
    this.config = config;
  }

  /**
   * Start each configured server, list its tools, and register them in the
   * provided ToolRegistry. Returns the same registry for chaining.
   */
  async connect(registry: ToolRegistry): Promise<Result<ToolRegistry>> {
    for (const serverConfig of this.config.servers) {
      const connectResult = await this.connectOne(serverConfig, registry);
      if (!connectResult.ok) return connectResult;
    }
    return { ok: true, value: registry };
  }

  /** Cleanly close all server connections. */
  async disconnect(): Promise<void> {
    for (const conn of this.connections) {
      try {
        await conn.client.close();
      } catch {
        // Best-effort — don't throw on cleanup
      }
    }
    this.connections.length = 0;
  }

  private async connectOne(
    serverConfig: McpServerConfig,
    registry: ToolRegistry,
  ): Promise<Result<void>> {
    let transport: Transport;

    if (serverConfig.kind === "stdio") {
      transport = new StdioClientTransport({
        command: serverConfig.command,
        args: [...serverConfig.args],
        ...(serverConfig.env !== undefined ? { env: { ...serverConfig.env } } : {}),
        stderr: "pipe",
      });
    } else {
      // StreamableHTTPClientTransport typing uses exactOptionalPropertyTypes — cast via unknown
      // to avoid fighting the SDK's RequestInit vs DOM RequestInit mismatch.
      transport = new StreamableHTTPClientTransport(
        new URL(serverConfig.url),
      ) as unknown as Transport;
    }

    const client = new Client(
      { name: "emerge-mcp-client", version: "0.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "E_MCP_CONNECT",
          message: `Failed to connect to MCP server '${serverConfig.name}': ${String(err)}`,
          cause: err,
          retriable: false,
        },
      };
    }

    let toolList: Awaited<ReturnType<typeof client.listTools>>;
    try {
      toolList = await client.listTools();
    } catch (err) {
      await client.close().catch(() => undefined);
      return {
        ok: false,
        error: {
          code: "E_MCP_LIST_TOOLS",
          message: `Failed to list tools from MCP server '${serverConfig.name}': ${String(err)}`,
          cause: err,
          retriable: true,
        },
      };
    }

    const conn: ServerConnection = { config: serverConfig, client, transport };
    this.connections.push(conn);

    for (const mcpTool of toolList.tools) {
      const emergeToolName = `mcp__${serverConfig.name}__${mcpTool.name}`;
      const description =
        mcpTool.description ?? `MCP tool ${mcpTool.name} from ${serverConfig.name}`;
      const permission = this.config.defaultPermission ?? derivePermission(description);

      const spec: ToolSpec = {
        name: emergeToolName,
        description,
        inputSchema: makePassthroughSchemaRef(),
        jsonSchema: mcpTool.inputSchema ?? { type: "object" },
        permission,
      };

      const sandbox = this.config.sandbox;
      const tool: Tool = {
        spec,
        async invoke(call: ToolInvocation): Promise<Result<ToolResult, ContractError>> {
          const input = call.input as Record<string, unknown>;

          // Respect AbortSignal — if already aborted, refuse immediately
          if (call.signal?.aborted) {
            return {
              ok: false,
              error: { code: "E_ABORTED", message: "Tool call was cancelled before execution" },
            };
          }

          let mcpResult: Awaited<ReturnType<typeof client.callTool>>;
          const runResult = await sandbox.run(
            { effect: "state_read", target: emergeToolName },
            async () => {
              mcpResult = await client.callTool(
                { name: mcpTool.name, arguments: input },
                undefined,
                // AbortController → options signal
                call.signal ? { signal: call.signal } : undefined,
              );
              return mcpResult;
            },
          );

          if (!runResult.ok) return runResult;
          const callResult = runResult.value;

          if (!callResult || !Array.isArray(callResult.content)) {
            return {
              ok: true,
              value: { ok: true, preview: "(empty response from MCP server)" },
            };
          }

          // Build preview from text content blocks
          const textParts: string[] = [];
          const resourceRefs: string[] = [];

          for (const block of callResult.content) {
            if (block.type === "text" && typeof block.text === "string") {
              textParts.push(block.text);
            } else if (block.type === "resource" && block.resource) {
              const uri = (block.resource as { uri?: string }).uri ?? "(resource)";
              resourceRefs.push(uri);
            }
          }

          const preview = textParts.join("\n");
          const isError = callResult.isError === true;

          const result: ToolResult = {
            ok: !isError,
            preview:
              preview ||
              (resourceRefs.length > 0
                ? `Resources: ${resourceRefs.join(", ")}`
                : "(no text content)"),
            sizeBytes: preview.length,
            ...(resourceRefs.length > 0 ? { meta: { resourceUris: resourceRefs } } : {}),
          };

          return { ok: true, value: result };
        },
      };

      registry.register(tool);
    }

    return { ok: true, value: undefined };
  }
}
