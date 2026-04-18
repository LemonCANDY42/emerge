/**
 * Tests for the blueprint loader (ADR 0037 / CLI).
 *
 * Each test is load-bearing: reverting production code causes it to fail.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlueprintSchema, loadBlueprint } from "./blueprint.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "emerge-cli-test-"));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content, "utf-8");
  return p;
}

const VALID_BLUEPRINT = `
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
  tools: ["read_file", "write_file"]
termination:
  maxIterations: 10
  maxWallMs: 30000
verification:
  mode: "off"
  requireVerdictBeforeExit: false
trustMode: "implicit"
`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("loadBlueprint", () => {
  it("loads a valid blueprint", async () => {
    const p = await write("valid.yaml", VALID_BLUEPRINT);
    const result = await loadBlueprint(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contract.id).toBe("demo-contract");
    expect(result.value.agent.id).toBe("writer");
    expect(result.value.agent.tools).toEqual(["read_file", "write_file"]);
    expect(result.value.termination.maxIterations).toBe(10);
    expect(result.value.trustMode).toBe("implicit");
  });

  it("returns error for missing file", async () => {
    const result = await loadBlueprint(path.join(tmpDir, "nonexistent.yaml"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_BLUEPRINT_READ");
  });

  it("returns error for invalid YAML", async () => {
    const p = await write("bad-yaml.yaml", "{ invalid: yaml: [");
    const result = await loadBlueprint(p);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_BLUEPRINT_YAML");
  });

  it("returns error for wrong schemaVersion", async () => {
    const p = await write("wrong-version.yaml", VALID_BLUEPRINT.replace('"1.0.0"', '"2.0.0"'));
    const result = await loadBlueprint(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_BLUEPRINT_VERSION");
      expect(result.error.message).toContain("2.0.0");
    }
  });

  it("rejects unknown top-level keys (strict mode)", async () => {
    const p = await write("extra-key.yaml", `${VALID_BLUEPRINT}\nunknownKey: oops\n`);
    const result = await loadBlueprint(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_BLUEPRINT_VALIDATION");
      expect(result.error.message).toContain("unknownKey");
    }
  });

  it("rejects negative maxIterations", async () => {
    const bad = VALID_BLUEPRINT.replace("maxIterations: 10", "maxIterations: -1");
    const p = await write("neg-iterations.yaml", bad);
    const result = await loadBlueprint(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_BLUEPRINT_VALIDATION");
    }
  });

  it("rejects maxIterations of zero", async () => {
    const bad = VALID_BLUEPRINT.replace("maxIterations: 10", "maxIterations: 0");
    const p = await write("zero-iterations.yaml", bad);
    const result = await loadBlueprint(p);
    expect(result.ok).toBe(false);
  });

  it("rejects unknown verification mode", async () => {
    const bad = VALID_BLUEPRINT.replace('mode: "off"', 'mode: "invalid"');
    const p = await write("bad-verify.yaml", bad);
    const result = await loadBlueprint(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_BLUEPRINT_VALIDATION");
    }
  });

  it("rejects unknown agent provider kind", async () => {
    const bad = VALID_BLUEPRINT.replace('kind: "static"', 'kind: "dynamic"');
    const p = await write("bad-provider.yaml", bad);
    const result = await loadBlueprint(p);
    expect(result.ok).toBe(false);
  });

  it("accepts blueprint with no tools (defaults to empty array)", async () => {
    const minimal = `
schemaVersion: "1.0.0"
contract:
  id: "c1"
  goal: "test"
agent:
  id: "a1"
  role: "worker"
  provider:
    kind: "static"
    providerId: "mock"
termination:
  maxIterations: 5
  maxWallMs: 10000
trustMode: "implicit"
`;
    const p = await write("no-tools.yaml", minimal);
    const result = await loadBlueprint(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agent.tools).toEqual([]);
  });
});

describe("BlueprintSchema", () => {
  it("rejects wrong type for maxIterations", () => {
    const result = BlueprintSchema.safeParse({
      schemaVersion: "1.0.0",
      contract: { id: "c1", goal: "g1" },
      agent: { id: "a1", role: "r", provider: { kind: "static", providerId: "mock" }, tools: [] },
      termination: { maxIterations: "not-a-number", maxWallMs: 10000 },
      trustMode: "implicit",
    });
    expect(result.success).toBe(false);
  });
});
