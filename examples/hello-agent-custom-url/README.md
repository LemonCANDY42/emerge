# hello-agent-custom-url

Runs the hello-agent task (read README, summarize, write NOTES.md) against any
OpenAI-compatible endpoint using `@emerge/provider-openai-compat`.

## Quick start

```bash
# Ollama
EMERGE_LLM_BASE_URL=http://localhost:11434/v1 \
EMERGE_LLM_MODEL=llama3.2 \
  node examples/hello-agent-custom-url/dist/index.js

# vLLM
EMERGE_LLM_BASE_URL=http://localhost:8000/v1 \
EMERGE_LLM_MODEL=meta-llama/Llama-3-8b-instruct \
  node examples/hello-agent-custom-url/dist/index.js

# OpenRouter
EMERGE_LLM_BASE_URL=https://openrouter.ai/api/v1 \
EMERGE_LLM_API_KEY=sk-or-... \
EMERGE_LLM_MODEL=meta-llama/llama-3.3-70b-instruct \
  node examples/hello-agent-custom-url/dist/index.js

# Custom gateway with Responses API + reasoning
EMERGE_LLM_BASE_URL=https://gmn.chuangzuoli.com/v1 \
EMERGE_LLM_API_KEY=sk-... \
EMERGE_LLM_MODEL=gpt-5.4 \
EMERGE_LLM_PROTOCOL=responses \
EMERGE_LLM_REASONING_EFFORT=xhigh \
  node examples/hello-agent-custom-url/dist/index.js
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `EMERGE_LLM_BASE_URL` | Yes | Base URL of the endpoint (see path note below) |
| `EMERGE_LLM_MODEL` | Yes | Model name |
| `EMERGE_LLM_API_KEY` | No | API key (many local services don't need one) |
| `EMERGE_LLM_PROTOCOL` | No | `"chat"` (default) or `"responses"` |
| `EMERGE_LLM_REASONING_EFFORT` | No | `"minimal"/"low"/"medium"/"high"/"xhigh"` |

## Common gotchas

### If your gateway returns 404

The OpenAI Node SDK appends only `/<endpoint>` directly to the `baseURL`
(e.g. `/responses` or `/chat/completions`). It does **not** add `/v1` automatically.

For gateways that expose the standard `/v1/<endpoint>` paths, **include `/v1` in `EMERGE_LLM_BASE_URL`**:

- `EMERGE_LLM_BASE_URL=https://api.example.com/v1` → hits `/v1/responses` (correct)
- `EMERGE_LLM_BASE_URL=https://api.example.com` → hits `/responses` (wrong — 404)

If your gateway mounts the API at root (`/`) instead of `/v1`, omit the `/v1` suffix.
Most gateways that claim OpenAI compatibility do mount at `/v1`.

### If your gateway returns 502 intermittently

Retry is enabled by default (3 attempts, exponential backoff). Each retry logs:

```
[openai] retry 1/2 after 623ms status=502 err=Bad Gateway
```

To disable retry, set `retry: false` in the provider config (requires code change).

### If you see a baseURL path warning

```
[openai] WARNING: baseURL "https://api.example.com/v1/responses" appears to include an endpoint path.
```

Remove the endpoint path from `EMERGE_LLM_BASE_URL`. The SDK appends `/<endpoint>` itself.
Correct form: `EMERGE_LLM_BASE_URL=https://api.example.com/v1`.

```
[openai] WARNING: baseURL "https://api.example.com" does not end with "/v1".
```

Add `/v1` to `EMERGE_LLM_BASE_URL` if your gateway mounts the API at `/v1`
(which is true for almost all OpenAI-compatible gateways):
`EMERGE_LLM_BASE_URL=https://api.example.com/v1`.

### Reasoning / thinking

To pass reasoning effort for o-series or gpt-5.x models:

```bash
EMERGE_LLM_REASONING_EFFORT=high
```

This sets `reasoning.effort` in the Responses API call, or `reasoning_effort` in
Chat Completions. The value `"xhigh"` is non-standard and passed verbatim.

See [docs/providers/reasoning-and-thinking.md](../../docs/providers/reasoning-and-thinking.md)
for the full reference.
