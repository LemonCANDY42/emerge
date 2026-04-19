# @lwrf42/emerge-provider-openai

OpenAI provider adapter (chat and responses protocols) for the emerge agent harness.

v0.1.0 — early. Real-model verified against `gpt-5.4` via an OpenAI-compatible gateway. Direct `api.openai.com` not yet verified end-to-end — see VERIFICATION.md.

## Install

```bash
npm install @lwrf42/emerge-provider-openai
```

## Quick example

```ts
import { OpenAIProvider } from "@lwrf42/emerge-provider-openai";

const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  // Optional overrides:
  // model: "gpt-4o",
  // baseURL: "https://api.openai.com/v1",
  // protocol: "chat",  // or "responses"
});
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `OPENAI_API_KEY` | API key | required |
| `OPENAI_BASE_URL` | Custom base URL | OpenAI default |
| `OPENAI_MODEL` | Model name | gpt-4o |
| `OPENAI_PROTOCOL` | `chat` or `responses` | `chat` |

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
