# @emerge/provider-anthropic

Anthropic Claude provider adapter for the emerge agent harness.

v0.1.0 — early. Shipped but not yet verified end-to-end with a real Anthropic API key. See VERIFICATION.md.

## Install

```bash
npm install @emerge/provider-anthropic
```

## Quick example

```ts
import { AnthropicProvider } from "@emerge/provider-anthropic";

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Optional overrides:
  // model: "claude-opus-4-7",
  // baseURL: "https://your-proxy.example.com",
});

// Use with any emerge Kernel or blueprint.
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | API key | required |
| `ANTHROPIC_BASE_URL` | Custom base URL (proxy) | Anthropic default |
| `ANTHROPIC_MODEL` | Model name | claude-opus-4-5 |

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
