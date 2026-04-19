# @emerge/cli

Command-line interface for the emerge agent harness: `run`, `replay`, `probe`, and `status` commands.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install -g @emerge/cli
```

Or run without installing:

```bash
npx @emerge/cli run blueprint.yaml
```

## Commands

```bash
# Run an agent from a blueprint YAML
emerge run blueprint.yaml

# Replay a recorded session from a JSONL log
emerge replay session.jsonl

# Probe model capability on a task
emerge probe blueprint.yaml

# Show session status
emerge status
```

## Blueprint format

```yaml
# blueprint.yaml
id: my-task
title: Fix the broken function
provider:
  kind: openai-compat
  baseURL: ${EMERGE_LLM_BASE_URL}
  model: ${EMERGE_LLM_MODEL}
systemPrompt: |
  You are a senior engineer. Fix the bug in the repo.
tools:
  - fs_read
  - fs_write
  - bash
```

## Quick example

```bash
EMERGE_LLM_BASE_URL=http://localhost:11434/v1 \
EMERGE_LLM_MODEL=llama3.2 \
emerge run blueprint.yaml
```

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
