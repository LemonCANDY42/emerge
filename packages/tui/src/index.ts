/**
 * @lwrf42/emerge-tui — public API.
 *
 * For the CLI (emerge-tui live/replay), use the bin at dist/cli.js.
 * For in-process embedding, use runTui() + makeTuiEventSource().
 */

// In-process TUI API
export { runTui, makeTuiEventSource } from "./run-tui.js";
export type { RunTuiOptions, TuiEventSource } from "./run-tui.js";

// State utilities (useful for testing / custom rendering)
export { applyEvent, applyEvents } from "./state/reducer.js";
export { EMPTY_STATE } from "./state/types.js";
export type {
  TuiState,
  AgentNode,
  AgentLifecycle,
  VerdictEntry,
  VerdictKind,
  AgentUsage,
  PinnedItem,
} from "./state/types.js";
