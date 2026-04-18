# Blueprint YAML reference

A blueprint is a YAML file that configures an emerge session for the CLI.
Run it with:

```bash
emerge run path/to/blueprint.yaml
```

## Schema version

Every blueprint must start with:

```yaml
schemaVersion: "1.0.0"
```

Unknown top-level keys are rejected. Schema version mismatches produce a clear
error message. To migrate a blueprint to a new schema version, see the migration
note in the relevant release's changelog.

## Example

```yaml
schemaVersion: "1.0.0"
contract:
  id: "demo-contract"
  goal: "Read README.md and write a one-line summary to NOTES.md"
agent:
  id: "writer"
  role: "general"
  provider:
    kind: "static"
    providerId: "mock"
  tools: []
termination:
  maxIterations: 10
  maxWallMs: 30000
verification:
  mode: "off"
  requireVerdictBeforeExit: false
trustMode: "implicit"
```

## Fields

### `contract` (required)

```yaml
contract:
  id: "my-contract-id"  # string, required
  goal: "Human-readable task description"  # string, required
```

`id` is used as the `ContractId` in the kernel. `goal` is injected into the
agent's system prompt when no explicit `agent.system` is provided.

---

### `agent` (required)

```yaml
agent:
  id: "my-agent"        # string, required — must be unique in the session
  role: "general"       # string, required — e.g. "general", "worker", "supervisor"
  provider:
    kind: "static"      # currently only "static" is supported
    providerId: "mock"  # provider registered with the kernel
  tools: ["fs.read", "fs.write"]  # list of tool names; default: []
  system: "Optional system prompt override"  # optional
```

**Supported providers in CLI v1:** only `"mock"` (no API key required).
For real providers (Anthropic, OpenAI, etc.), use the TypeScript library API
directly and wire your own `Kernel` instance.

`tools` must reference tool names already registered with the kernel. The CLI
v1 does not register file-system or MCP tools by default — `tools` is accepted
in the blueprint for forward-compatibility but the mock provider ignores them.

---

### `termination` (required)

```yaml
termination:
  maxIterations: 10   # integer >= 1, required
  maxWallMs: 30000    # integer >= 1 (milliseconds), required
```

The agent loop stops when either limit is reached. A wall-time of 30 seconds
(`30000`) is a reasonable default for demos. For long-running tasks, set
`maxWallMs` to a value appropriate for your provider latency.

---

### `verification` (optional)

```yaml
verification:
  mode: "off"                      # "off" | "per-step" | "on-failure"
  requireVerdictBeforeExit: false  # boolean, default: false
```

`mode: "off"` disables post-step verification (default and recommended for
demos without a configured Adjudicator).

`requireVerdictBeforeExit: true` causes the session to fail if no adjudicator
verdict was issued. Only useful when an Adjudicator is mounted (library API).

---

### `trustMode` (optional)

```yaml
trustMode: "explicit"  # "implicit" | "explicit", default: "explicit"
```

`"explicit"` — session requires an aligned Adjudicator verdict to complete
(the default). If no Adjudicator is mounted, `endSession()` will warn once but
still succeed; the gate is only enforced when an Adjudicator is configured.

`"implicit"` — session ends without verdict gating. Use this for demos and
quick tests where you intentionally run without an Adjudicator. Set it
explicitly in your blueprint — it is no longer the default so that production
blueprints that omit the field benefit from the stricter behaviour.

**Why the default changed (M3c2):** ADR 0012 and ADR 0035 define kernel-level
verification gates. The previous default of `"implicit"` silently bypassed both
gates. Blueprints that relied on the implicit default continue to work — just
add `trustMode: implicit` explicitly.

---

## Notes on v1 scope

Blueprint v1 supports a single agent with a static provider. Multi-agent
topologies (supervisor-worker, pipeline, worker-pool) are planned for M3d
and will require a richer blueprint schema. Until then, use the TypeScript
library API to wire multi-agent sessions.

Unknown top-level keys (e.g. `topology:`, `agents:`) are explicitly rejected
by the Zod schema so that future schema additions don't silently pass through
on old CLI versions.
