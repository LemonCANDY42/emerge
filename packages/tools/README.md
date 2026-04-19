# @emerge/tools

Tool registry, filesystem and bash tools, and tool composition utilities for the emerge agent harness.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install @emerge/tools
```

## Quick example

```ts
import { makeFsReadTool, makeFsWriteTool, makeBashTool } from "@emerge/tools";

const tools = [
  makeFsReadTool({ sandbox }),
  makeFsWriteTool({ sandbox, permission: { defaultMode: "auto" } }),
  makeBashTool({ sandbox, permission: { defaultMode: "auto" } }),
];

// Pass tools array to AgentSpec or blueprint.
const spec: AgentSpec = { id: "agent-1", provider, tools, systemPrompt };
```

## Included tools

| Tool factory | Description |
|---|---|
| `makeFsReadTool` | Read file contents from the workspace |
| `makeFsWriteTool` | Write or patch files in the workspace |
| `makeBashTool` | Execute bash commands via the sandbox |

All tools respect the sandbox permission policy.

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
