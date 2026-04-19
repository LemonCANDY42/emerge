/**
 * @lwrf42/emerge-tui/state — public sub-path export.
 *
 * Re-exports the pure reducer and types so downstream packages (e.g.
 * @lwrf42/emerge-dashboard) can share the exact same state derivation without
 * duplicating logic or importing Ink/React.
 *
 * Only pure TypeScript here — no Ink, no React, no side-effects.
 */

export { applyEvent, applyEvents } from "./reducer.js";
export { EMPTY_STATE, MAX_VERDICTS } from "./types.js";
export type {
  TuiState,
  AgentNode,
  AgentLifecycle,
  VerdictEntry,
  VerdictKind,
  AgentUsage,
  PinnedItem,
} from "./types.js";
