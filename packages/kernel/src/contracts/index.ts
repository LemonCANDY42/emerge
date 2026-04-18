/**
 * Public contract surface for @emerge/kernel.
 *
 * This is the file every implementation package builds against. Changes here
 * are versioned carefully — see CLAUDE.md and ARCHITECTURE.md.
 */

export * from "./common.js";
export * from "./provider.js";
export * from "./tool.js";
export * from "./memory.js";
export * from "./agent.js";
export * from "./surveillance.js";
export * from "./sandbox.js";
export * from "./telemetry.js";

// Round 2/3 — comms, topology, contracts, safety, roles, blueprints
export * from "./bus.js";
export * from "./agent-card.js";
export * from "./topology.js";
export * from "./termination.js";
export * from "./lineage.js";
export * from "./contract.js";
export * from "./custodian.js";
export * from "./adjudicator.js";
export * from "./quota.js";
export * from "./blueprint.js";
export * from "./artifact.js";
export * from "./pinned.js";
export * from "./kernel-config.js";

// Round 4 — replay, experience, modes, permissions, cost, reproducibility,
// human-in-loop, workspaces, speculative branches, projections
export * from "./replay.js";
export * from "./experience.js";
export * from "./mode.js";
export * from "./permission.js";
export * from "./cost.js";
export * from "./reproducibility.js";
export * from "./human.js";
export * from "./workspace.js";
export * from "./branch.js";
export * from "./projection.js";

// M3c2: JSONL event schema — public, versioned contract (ADR 0037)
export * from "./jsonl-schema.js";
