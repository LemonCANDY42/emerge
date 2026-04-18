/**
 * `emerge run <blueprint.yaml>` — load a blueprint, run the configured agent,
 * print result + cost summary, exit with code reflecting success.
 *
 * Supported providers in v1 CLI:
 *   - providerId "mock" → MockProvider (no API key required)
 *
 * For real providers, users wire their own kernel and use the library API.
 * The CLI is a zero-configuration entry point for mock-provider demos.
 */

import type { AgentId, ContractId, SessionId } from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { MockProvider } from "@emerge/provider-mock";
import { makeRecorder } from "@emerge/replay";
import { JsonlTelemetry } from "@emerge/telemetry-jsonl";
import { type BlueprintConfig, loadBlueprint } from "../blueprint.js";

export interface RunCommandOptions {
  /** Directory to write session JSONL. Default: ".emerge" relative to cwd. */
  outputDir?: string;
}

/**
 * Build and run a kernel from a blueprint config.
 *
 * Separated from `runCommand` so tests can invoke it directly without the
 * file-system overhead of writing YAML.
 */
export async function runFromBlueprint(
  config: BlueprintConfig,
  opts: RunCommandOptions = {},
): Promise<{ exitCode: number; summary: string }> {
  const outputDir = opts.outputDir ?? ".emerge";
  const sessionId = `cli-${Date.now()}` as SessionId;
  const telemetryPath = `${outputDir}/${sessionId}-telemetry.jsonl`;
  const sessionPath = `${outputDir}/${sessionId}-session.jsonl`;

  // Resolve provider
  const { providerId } = config.agent.provider;
  let provider: InstanceType<typeof MockProvider>;
  if (providerId === "mock") {
    // Default mock script: one turn, end_turn
    provider = new MockProvider(
      [
        {
          events: [
            {
              type: "text_delta",
              text: `[mock] Running agent "${config.agent.id}" for goal: ${config.contract.goal}`,
            },
            {
              type: "stop",
              reason: "end_turn",
              usage: { tokensIn: 10, tokensOut: 20, wallMs: 50, toolCalls: 0, usd: 0.0 },
            },
          ],
        },
      ],
      "mock",
    );
  } else {
    return {
      exitCode: 1,
      summary: `Provider "${providerId}" is not supported by the CLI in v1. Use "mock" or wire a kernel manually.`,
    };
  }

  const recorder = makeRecorder({ filePath: sessionPath });
  const telemetry = new JsonlTelemetry(telemetryPath);

  const kernel = new Kernel(
    {
      mode: "auto",
      reproducibility: "free",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 256 },
      roles: {},
      trustMode: config.trustMode,
    },
    { recorder, telemetry },
  );

  kernel.mountProvider(provider);

  const contractId = config.contract.id as ContractId;
  kernel.setSession(sessionId, contractId);

  const agentId = config.agent.id as AgentId;
  const spawnResult = await kernel.spawn({
    id: agentId,
    role: config.agent.role,
    description: config.contract.goal,
    provider: { kind: "static", providerId: provider.capabilities.id },
    system: {
      kind: "literal",
      text: config.agent.system ?? `You are an agent. Goal: ${config.contract.goal}`,
    },
    toolsAllowed: config.agent.tools,
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    budget: { tokensIn: 10_000, tokensOut: 2_000, usd: 1.0 },
    termination: {
      maxIterations: config.termination.maxIterations,
      maxWallMs: config.termination.maxWallMs,
      budget: { tokensIn: 10_000, tokensOut: 2_000 },
      retry: { transient: 3, nonRetryable: 0 },
      cycle: { windowSize: 5, repeatThreshold: 3 },
      done: { kind: "predicate", description: "Agent finishes with end_turn" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: config.agent.tools,
      modalities: ["text"],
      qualityTier: "standard",
      streaming: true,
      interrupts: false,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
  });

  if (!spawnResult.ok) {
    telemetry.close();
    return {
      exitCode: 1,
      summary: `Failed to spawn agent: ${spawnResult.error.message}`,
    };
  }

  const handle = spawnResult.value;
  await kernel.runAgent(handle);

  const endResult = await kernel.endSession();
  telemetry.close();

  if (!endResult.ok) {
    return {
      exitCode: 1,
      summary: `Session ended with error: ${endResult.error.message}`,
    };
  }

  const record = endResult.value.record;
  const cost = kernel.getCostMeter().ledger();
  const snapshot = await handle.snapshot();
  const agentState = snapshot.state;

  const lines: string[] = [
    `Session: ${String(sessionId)}`,
    `Contract: ${config.contract.id} — ${config.contract.goal}`,
    `Agent: ${String(handle.id)} (${agentState})`,
    `Events: ${record?.events.length ?? 0}`,
    `Tokens in: ${snapshot.usage.tokensIn}`,
    `Tokens out: ${snapshot.usage.tokensOut}`,
    `USD: $${snapshot.usage.usd.toFixed(6)}`,
    `Total cost: $${cost.totals.grand.toFixed(6)}`,
    `Session JSONL: ${sessionPath}`,
    `Telemetry JSONL: ${telemetryPath}`,
  ];

  // Exit code reflects agent completion state: only "completed" is success.
  if (agentState !== "completed") {
    const runner = handle as unknown as {
      lastError(): { code: string; message: string } | undefined;
    };
    const lastError = runner.lastError();
    const errorLine =
      lastError !== undefined
        ? `Agent error: [${lastError.code}] ${lastError.message}`
        : `Agent ended in state: ${agentState}`;
    return { exitCode: 1, summary: `${lines.join("\n")}\n${errorLine}` };
  }

  return { exitCode: 0, summary: lines.join("\n") };
}

/**
 * CLI entry point for `emerge run <blueprint.yaml>`.
 * Exits the process with the appropriate exit code.
 */
export async function runCommand(
  blueprintPath: string,
  opts: RunCommandOptions = {},
): Promise<void> {
  const loadResult = await loadBlueprint(blueprintPath);
  if (!loadResult.ok) {
    console.error(`[emerge run] ${loadResult.error.message}`);
    process.exit(1);
  }

  const { exitCode, summary } = await runFromBlueprint(loadResult.value, opts);

  if (exitCode === 0) {
    console.log(summary);
  } else {
    console.error(`[emerge run] ${summary}`);
  }
  process.exit(exitCode);
}
