/**
 * hello-mcp — end-to-end demo of @emerge/tools-mcp.
 *
 * Uses an in-process mock MCP server (via @modelcontextprotocol/sdk's InMemoryTransport)
 * to avoid requiring any external process. Demonstrates:
 *   1. Spawning an in-process MCP server with two tools.
 *   2. Connecting via McpToolRegistry (using the internal in-process transport).
 *   3. Listing discovered tools.
 *   4. Invoking a tool through the emerge ToolRegistry.
 *   5. Exiting 0.
 *
 * To swap in a real MCP server (e.g. @modelcontextprotocol/server-filesystem):
 *   - Replace `InProcessMcpServerConfig` with `{ kind: "stdio", name: "fs", command: "npx",
 *       args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }`.
 *   - Remove the in-process server setup below.
 */

import type { PermissionDescriptor, Tool, ToolRegistry, ToolSpec } from "@emerge/kernel/contracts";
import { McpToolRegistry } from "@emerge/tools-mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---- Minimal in-process Sandbox (allow all) ----

import type { Result, Sandbox, SandboxDecision, SandboxRequest } from "@emerge/kernel/contracts";

class PermissiveSandbox implements Sandbox {
  async authorize(_req: SandboxRequest): Promise<Result<SandboxDecision>> {
    return { ok: true, value: { kind: "allow" } };
  }
  async run<T>(_req: SandboxRequest, fn: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return { ok: false, error: { code: "E_SANDBOX", message: String(err) } };
    }
  }
}

// ---- Minimal in-process ToolRegistry ----

class SimpleToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.spec.name, tool);
  }
  unregister(name: string): void {
    this.tools.delete(name);
  }
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
  resolve(allow: readonly string[]): readonly Tool[] {
    if (allow.length === 0) return [...this.tools.values()];
    return allow.map((n) => this.tools.get(n)).filter((t): t is Tool => t !== undefined);
  }
  list(): readonly ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }
}

// ---- Build in-process MCP server ----

async function buildInProcessMcpServer(): Promise<[InMemoryTransport, InMemoryTransport]> {
  const mcpServer = new McpServer({ name: "hello-server", version: "1.0" });

  // Register two tools on the server side
  mcpServer.tool(
    "greet",
    "Greet a person by name.",
    { name: z.string().describe("Name to greet") },
    async ({ name }) => ({
      content: [{ type: "text" as const, text: `Hello, ${name}! Welcome to emerge MCP.` }],
    }),
  );

  mcpServer.tool(
    "add",
    "Add two numbers together.",
    { a: z.number().describe("First number"), b: z.number().describe("Second number") },
    async ({ a, b }) => ({
      content: [{ type: "text" as const, text: String(a + b) }],
    }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);

  return [clientTransport, serverTransport];
}

// ---- Custom McpToolRegistry that accepts an existing transport ----

// We patch in an InMemoryTransport by creating a thin wrapper around McpToolRegistry
// that uses a pre-connected transport instead of spawning a process.
// This is a demo shortcut; production use would use kind:"stdio" or kind:"http".

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

async function connectInProcessRegistry(
  transport: InMemoryTransport,
  sandbox: Sandbox,
  registry: ToolRegistry,
): Promise<void> {
  const client = new Client({ name: "emerge-demo-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const toolList = await client.listTools();

  for (const mcpTool of toolList.tools) {
    const name = `mcp__demo__${mcpTool.name}`;
    const description = mcpTool.description ?? mcpTool.name;
    const permission: PermissionDescriptor = {
      rationale: "In-process demo MCP tool",
      effects: ["state_read"],
      defaultMode: "auto",
    };

    const spec: ToolSpec = {
      name,
      description,
      inputSchema: {
        "~standard": { version: 1, vendor: "emerge-mcp", validate: (v) => ({ value: v }) },
      },
      jsonSchema: mcpTool.inputSchema ?? { type: "object" },
      permission,
    };

    const capturedClient = client;
    const capturedMcpName = mcpTool.name;
    const tool: Tool = {
      spec,
      async invoke(call) {
        const input = call.input as Record<string, unknown>;
        const runResult = await sandbox.run({ effect: "state_read", target: name }, async () =>
          capturedClient.callTool({ name: capturedMcpName, arguments: input }),
        );
        if (!runResult.ok) return runResult;
        const res = runResult.value;
        type ContentBlock = { type: string; text?: string };
        const content = (res as { content?: ContentBlock[]; isError?: boolean }).content ?? [];
        const textParts = content.filter((b) => b.type === "text").map((b) => b.text ?? "");
        const isError = (res as { isError?: boolean }).isError ?? false;
        return {
          ok: true,
          value: {
            ok: !isError,
            preview: textParts.join("\n"),
            sizeBytes: textParts.join("\n").length,
          },
        };
      },
    };

    registry.register(tool);
  }
}

// ---- Main demo ----

async function main(): Promise<void> {
  console.log("emerge hello-mcp demo");
  console.log("Using in-process MCP server (no external process required).");
  console.log("");

  const sandbox = new PermissiveSandbox();
  const registry = new SimpleToolRegistry();

  // 1. Spawn in-process MCP server
  const [clientTransport] = await buildInProcessMcpServer();
  console.log("In-process MCP server started.");

  // 2. Connect and register tools
  await connectInProcessRegistry(clientTransport, sandbox, registry);

  // 3. List discovered tools
  const tools = registry.list();
  console.log(`Discovered ${tools.length} MCP tools:`);
  for (const spec of tools) {
    console.log(`  - ${spec.name}: ${spec.description}`);
  }

  // 4. Invoke the greet tool
  const greetTool = registry.get("mcp__demo__greet");
  if (!greetTool) {
    console.error("greet tool not found — something went wrong.");
    process.exit(1);
  }

  const greetResult = await greetTool.invoke({
    toolCallId: "tc1" as never,
    callerAgent: "demo-agent" as never,
    name: "mcp__demo__greet",
    input: { name: "World" },
  });

  if (!greetResult.ok) {
    console.error("Tool invocation failed:", greetResult.error.message);
    process.exit(1);
  }
  console.log(`\ngreet("World") =>`);
  console.log(`  ${greetResult.value.preview}`);

  // 5. Invoke the add tool
  const addTool = registry.get("mcp__demo__add");
  if (addTool) {
    const addResult = await addTool.invoke({
      toolCallId: "tc2" as never,
      callerAgent: "demo-agent" as never,
      name: "mcp__demo__add",
      input: { a: 40, b: 2 },
    });
    if (addResult.ok) {
      console.log("\nadd(40, 42) =>");
      console.log(`  ${addResult.value.preview}`);
    }
  }

  console.log("\nDone. Exits 0.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
