# Reasoning and thinking configuration

emerge supports reasoning/thinking knobs for model families that expose them.
Each provider has its own option shape; this document maps env vars to config
and documents which models support which knob.

---

## OpenAI — Responses API (`protocol: "responses"`)

**Models:** `gpt-5.x`, `o3`, `o3-mini` (when using the Responses API endpoint)

The Responses API accepts a `reasoning` object with `effort` and optional `summary`.

### Config

```ts
import { OpenAIProvider } from "@emerge/provider-openai";

const provider = new OpenAIProvider({
  apiKey: "sk-...",
  model: "gpt-5.4",
  protocol: "responses",
  baseURL: "https://api.openai.com/v1", // must include /v1 for standard gateways
  reasoning: {
    effort: "high",      // "minimal" | "low" | "medium" | "high" | "xhigh"
    summary: "concise",  // "auto" | "concise" | "detailed" | null (optional)
  },
});
```

The `"xhigh"` effort value is non-standard; it is passed verbatim to the
upstream. If the upstream rejects it, you will see a provider error event.

### Environment variables

```bash
OPENAI_REASONING_EFFORT=high
OPENAI_REASONING_SUMMARY=concise
```

Both are optional and override one another only when explicitly set.

---

## OpenAI — Chat Completions (`protocol: "chat"`)

**Models:** `o1`, `o3-mini` (o-series via Chat Completions)

The Chat Completions path uses `reasoning_effort` as a top-level parameter.
The `summary` field is ignored (not supported by this endpoint).

### Config

```ts
const provider = new OpenAIProvider({
  apiKey: "sk-...",
  model: "o3-mini",
  protocol: "chat",   // default
  reasoning: { effort: "high" },
});
```

### Environment variables

```bash
OPENAI_REASONING_EFFORT=high
```

---

## Anthropic — Extended thinking

**Models:** `claude-3-7-sonnet-20250219`, `claude-opus-4-7` (and later claude-opus-4-x)

When enabled, Claude performs internal reasoning before responding. Thinking
deltas stream as `ProviderEvent { type: "thinking_delta", text }`.

### Config

```ts
import { AnthropicProvider } from "@emerge/provider-anthropic";

const provider = new AnthropicProvider({
  apiKey: "sk-ant-...",
  model: "claude-3-7-sonnet-20250219",
  thinking: { type: "enabled", budget_tokens: 8192 },
});
```

To disable explicitly:

```ts
thinking: { type: "disabled" }
```

### Environment variable

```bash
ANTHROPIC_THINKING_BUDGET=8192   # positive integer enables; absent or 0 disables
```

---

## OpenAI-compat — `extraParams` and `reasoning`

**Any gateway using the `@emerge/provider-openai-compat` wrapper**

The compat provider supports two mechanisms for passing extra fields:

1. **`reasoning`** — same typed config as the OpenAI provider, forwarded verbatim.
2. **`extraParams`** — a `Record<string, unknown>` merged into every API call.
   Use this for gateway-specific fields your endpoint accepts.

```ts
import { OpenAICompatProvider } from "@emerge/provider-openai-compat";

const provider = new OpenAICompatProvider({
  name: "my-gateway",
  baseURL: "https://gmn.chuangzuoli.com/v1", // include /v1 for standard OpenAI-compat gateways
  model: "gpt-5.4",
  protocol: "responses",
  reasoning: { effort: "xhigh" },
  extraParams: {
    // Any gateway-specific fields go here
    x_routing_hint: "fast",
  },
});
```

### Environment variable for compat

```bash
EMERGE_LLM_REASONING_EFFORT=xhigh
```

---

## `/v1` path handling — important

The OpenAI Node SDK does **NOT** automatically append `/v1` to the `baseURL`.
It appends only `/<endpoint>` (e.g. `/responses` or `/chat/completions`) directly
to the `baseURL` you supply.

For OpenAI-compatible gateways that expose the standard `/v1/<endpoint>` paths,
you **MUST include `/v1` in your `baseURL`**:

- `baseURL: "https://api.openai.com/v1"` → hits `/v1/responses` (correct — this is the default)
- `baseURL: "https://gmn.chuangzuoli.com/v1"` → hits `/v1/responses` (correct)
- `baseURL: "https://gmn.chuangzuoli.com"` → hits `/responses` (wrong — 404)

**Always append `/v1` to the gateway host when the gateway mounts the API at `/v1`.**

### Common gotchas

- If you get **404**: check whether your `baseURL` ends with `/v1`. Most
  OpenAI-compatible gateways mount the API at `/v1`, so your `baseURL` must
  include it.
- If you get a warning `[openai] WARNING: baseURL "..." appears to include an
  endpoint path`: you have the full endpoint URL (e.g. `.../v1/responses`) as
  `baseURL`. Remove the endpoint suffix — the SDK appends `/<endpoint>` itself.
  Correct form: `baseURL: "https://host.example.com/v1"`.
- If you get a warning `[openai] WARNING: baseURL "..." does not end with "/v1"`:
  your gateway almost certainly needs `/v1` appended. Add it unless your gateway
  mounts the API at root.
- The emerge OpenAI provider emits construction-time warnings for both of the
  above cases.

---

## Retry-on-5xx

All providers (OpenAI, Anthropic, OpenAI-compat) retry transient failures by
default. The behavior is:

| Retriable status codes | 408, 425, 429, 500, 502, 503, 504 |
|---|---|
| Retriable node codes | ECONNRESET, ETIMEDOUT, ECONNREFUSED, EAI_AGAIN, ENOTFOUND |
| Non-retriable | 400, 401, 403, 404, 413, 422 (deterministic failures) |
| Default attempts | 3 (1 original + 2 retries) |
| Backoff | 500ms → 1000ms (exponential, ±20% jitter) |
| Cap | 10 000ms |

Mid-stream errors (after the first events have been yielded) are **not** retried
to prevent duplicate events. Only the stream-creation call is wrapped.

### Disable retry

```ts
const provider = new OpenAIProvider({ ..., retry: false });
```

### Custom retry config

```ts
const provider = new AnthropicProvider({
  ...,
  retry: {
    maxAttempts: 5,
    initialDelayMs: 200,
    maxDelayMs: 30_000,
    jitter: true,
  },
});
```

---

## Quick reference: env var → config mapping

| Env var | Provider | Config field |
|---|---|---|
| `OPENAI_REASONING_EFFORT` | OpenAI | `reasoning.effort` |
| `OPENAI_REASONING_SUMMARY` | OpenAI | `reasoning.summary` |
| `ANTHROPIC_THINKING_BUDGET` | Anthropic | `thinking.budget_tokens` |
| `EMERGE_LLM_REASONING_EFFORT` | OpenAI-compat | `reasoning.effort` |
