# Installation and Verification

Get emerge running on your machine. This guide is machine-readable and assumes you have Node.js and Git installed.

## Prerequisites

| Tool | Minimum version | Verify |
|---|---|---|
| Node.js | 18.x | `node --version` |
| pnpm | 8.x | `pnpm --version` |
| Git | 2.40 | `git --version` |

If you don't have pnpm:
```bash
npm install -g pnpm
```

## Install

1. **Clone the repository:**
   ```bash
   git clone https://github.com/LemonCANDY42/emerge.git
   cd emerge
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   ```

3. **Build all packages:**
   ```bash
   pnpm build
   ```

4. **Verify build succeeded:**
   ```bash
   pnpm typecheck
   ```
   Expected: no errors.

## Verify the installation

Run the type-check suite across all 26 packages:
```bash
pnpm test
```

Expected output: 115 tests pass, 0 fail. Build time ~30 seconds on a modern machine.

## Run a demo with MockProvider (no API key needed)

All demos exit 0 with a clear "skipped" message when API keys are absent — safe in CI.

**Hello Agent (the simplest demo):**
```bash
node examples/hello-agent/dist/index.js
```

Expected output:
```
Agent spawned: hello-agent
Running perceive → decide → act → observe loop...

Session complete: hello-{timestamp}
  Events recorded: N
  Started: 2026-04-17T...Z

Agent final state: completed
  Tokens in: 300
  Tokens out: 120
  USD: $0.0060

Cost ledger: $0.0060 total

NOTES.md written (150 bytes): OK

--- Task complete ---
```

## Try a real model

### Anthropic (Claude)

1. **Set your API key:**
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-your-key-here
   ```

2. **Run the demo:**
   ```bash
   node examples/hello-agent-anthropic/dist/index.js
   ```

3. **(Optional) Use a different model or base URL:**
   ```bash
   export ANTHROPIC_MODEL=claude-opus-4-7
   export ANTHROPIC_BASE_URL=https://api.anthropic.com
   node examples/hello-agent-anthropic/dist/index.js
   ```

### OpenAI (GPT)

1. **Set your API key:**
   ```bash
   export OPENAI_API_KEY=sk-your-key-here
   ```

2. **Run the demo:**
   ```bash
   node examples/hello-agent-openai/dist/index.js
   ```

3. **(Optional) Use a different model or protocol:**
   ```bash
   export OPENAI_MODEL=gpt-4o
   export OPENAI_BASE_URL=https://api.openai.com/v1
   export OPENAI_PROTOCOL=chat  # or 'responses'
   node examples/hello-agent-openai/dist/index.js
   ```

### Any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp, etc.)

1. **Point to your endpoint:**
   ```bash
   export EMERGE_LLM_BASE_URL=http://localhost:11434/v1
   export EMERGE_LLM_MODEL=llama3.2
   ```

2. **Run the demo:**
   ```bash
   node examples/hello-agent-custom-url/dist/index.js
   ```

3. **(Optional) Add an API key if your endpoint requires it:**
   ```bash
   export EMERGE_LLM_API_KEY=your-key-here
   export EMERGE_LLM_PROTOCOL=chat  # or 'responses'
   ```

## Troubleshooting

**Build fails with TypeScript errors:**
```bash
pnpm install
pnpm build
pnpm typecheck
```
Check for any `error TS` lines. Common cause: mismatch between Node version and `tsconfig.json` target. Ensure Node 18+.

**`pnpm test` fails:**
```bash
pnpm test -- --reporter=verbose
```
Look for any test with `FAIL`. Check the `examples/{name}/dist/` output. If the demo runs but the test fails, the agent loop completed but the assertion failed (e.g., output file not written).

**Demo runs but says "SKIPPED":**
This is expected when the API key env var is not set. Set the appropriate key (see "Try a real model" above) and run again.

**`ENOENT: no such file or directory` in a demo:**
The demo may be trying to read/write relative to its dist/ folder. Verify the working directory:
```bash
cd examples/hello-agent
node dist/index.js  # should work from examples/hello-agent/
# or from repo root
node examples/hello-agent/dist/index.js  # also works
```

**Out of memory during build:**
On low-memory machines, the monorepo build can be memory-intensive. Try:
```bash
pnpm install --filter ./packages/kernel
pnpm build --filter ./packages/kernel
# ... then gradually build other packages
```

**API rate limited:**
If you hit OpenAI or Anthropic rate limits:
- Wait 60 seconds.
- Run against MockProvider (no limit): `node examples/hello-agent/dist/index.js`.
- Use a local endpoint like Ollama (unlimited local calls).

## What's next?

- Read [docs/usage.md](./usage.md) to integrate emerge into your own TypeScript app.
- Read [docs/agents/index.md](./agents/index.md) to pick an agent type for your task.
- Check [docs/design/roadmap.md](./design/roadmap.md) to see what's shipped vs. planned.
