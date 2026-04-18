/**
 * @emerge/eval-terminal-bench — Terminal-Bench task runner for emerge.
 *
 * Loads a Terminal-Bench task spec (YAML/JSON), wires an emerge session
 * to solve it, runs acceptance tests, and emits a verdict + SessionRecord.
 */

export { parseTaskSpec, loadTask, materializeTask } from "./task-loader.js";
export type { TaskSpec, LoadedTask } from "./task-loader.js";

export { runAcceptance, makeAcceptanceEvaluator } from "./acceptance-runner.js";
export type { AcceptanceResult } from "./acceptance-runner.js";

export { buildSession } from "./session-builder.js";
export type { BuiltSession, SessionBuilderOptions, SandboxMode } from "./session-builder.js";

export { makeTerminalBenchBlueprint } from "./blueprint.js";
export type { TerminalBenchBlueprint, TerminalBenchBlueprintOptions } from "./blueprint.js";
