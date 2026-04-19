/**
 * @lwrf42/emerge-cli — public API surface for programmatic use.
 *
 * Most users invoke the CLI via `emerge run`, `emerge replay`, etc.
 * This module exposes the same commands as importable functions for
 * use in tests or embedding in other tools.
 */

export { loadBlueprint, BlueprintSchema, type BlueprintConfig } from "./blueprint.js";
export { runCommand, runFromBlueprint, type RunCommandOptions } from "./commands/run.js";
export { replayCommand } from "./commands/replay.js";
export { probeCommand } from "./commands/probe.js";
export { statusCommand, type StatusOptions } from "./commands/status.js";
