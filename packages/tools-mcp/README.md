# @lwrf42/emerge-tools-mcp

MCP (Model Context Protocol) tool integration for the emerge agent harness.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install @lwrf42/emerge-tools-mcp
```

## Quick example

```ts
import { mcpClientTool } from "@lwrf42/emerge-tools-mcp";

// Connect to an MCP server and expose its tools to an emerge agent.
const tool = await mcpClientTool({
  serverUrl: "http://localhost:3001",
  toolName: "search",
});

const spec: AgentSpec = {
  id: "agent-1",
  provider,
  tools: [tool],
  systemPrompt: "Use the search tool as needed.",
};
```

## What is MCP

The [Model Context Protocol](https://modelcontextprotocol.io/) standardizes how AI applications connect to external data sources and tools. This package bridges MCP servers into the emerge tool contract.

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
