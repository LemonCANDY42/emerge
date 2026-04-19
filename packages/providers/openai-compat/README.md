# @emerge/provider-openai-compat

OpenAI-compatible provider adapter for Ollama, vLLM, llama.cpp, LM Studio, OpenRouter, and any service that speaks the OpenAI chat API.

v0.1.0 — early. Real-model verified against `gpt-5.4` via custom gateway. Ollama, vLLM, llama.cpp shipped but not yet verified end-to-end — see VERIFICATION.md.

## Install

```bash
npm install @emerge/provider-openai-compat
```

## Quick example

```ts
import { OpenAICompatProvider } from "@emerge/provider-openai-compat";

// Ollama running locally
const provider = new OpenAICompatProvider({
  baseURL: "http://localhost:11434/v1",
  model: "llama3.2",
  // apiKey: "not-needed-for-ollama",
});

// Custom gateway
const provider2 = new OpenAICompatProvider({
  baseURL: process.env.EMERGE_LLM_BASE_URL,
  model: process.env.EMERGE_LLM_MODEL,
  apiKey: process.env.EMERGE_LLM_API_KEY,
});
```

## Environment variables

| Variable | Description |
|---|---|
| `EMERGE_LLM_BASE_URL` | Base URL of the compatible endpoint |
| `EMERGE_LLM_MODEL` | Model name |
| `EMERGE_LLM_API_KEY` | API key (empty string if not required) |
| `EMERGE_LLM_PROTOCOL` | `chat` or `responses` (default: `chat`) |

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
