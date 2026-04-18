/**
 * Dashboard — the four-quadrant layout.
 *
 * ┌──────────────────────────────────────────────┐
 * │ Topology tree          │ Verdict feed         │
 * ├──────────────────────────────────────────────┤
 * │ Cost / token meter     │ Pinned context       │
 * ├──────────────────────────────────────────────┤
 * │ [live/replay status bar]                      │
 * └──────────────────────────────────────────────┘
 */

import { Box } from "ink";
import type React from "react";
import type { TuiState } from "../state/types.js";
import { CostMeter } from "./CostMeter.js";
import { PinnedContext } from "./PinnedContext.js";
import { LiveStatusBar, type ReplayStatus, ReplayStatusBar } from "./StatusBar.js";
import { TopologyTree } from "./TopologyTree.js";
import { VerdictFeed } from "./VerdictFeed.js";

interface DashboardProps {
  readonly state: TuiState;
  readonly mode: "live" | "replay";
  readonly replayStatus?: ReplayStatus;
}

export function Dashboard({ state, mode, replayStatus }: DashboardProps): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%">
      {/* Top row: topology + verdicts */}
      <Box flexDirection="row" width="100%" minHeight={8}>
        <Box flexDirection="column" width="50%" borderStyle="single" paddingX={1}>
          <TopologyTree state={state} />
        </Box>
        <Box flexDirection="column" width="50%" borderStyle="single" paddingX={1}>
          <VerdictFeed state={state} />
        </Box>
      </Box>

      {/* Bottom row: cost + pinned */}
      <Box flexDirection="row" width="100%" minHeight={6}>
        <Box flexDirection="column" width="50%" borderStyle="single" paddingX={1}>
          <CostMeter state={state} />
        </Box>
        <Box flexDirection="column" width="50%" borderStyle="single" paddingX={1}>
          <PinnedContext state={state} />
        </Box>
      </Box>

      {/* Status bar */}
      {mode === "live" ? (
        <LiveStatusBar state={state} />
      ) : (
        replayStatus !== undefined && <ReplayStatusBar status={replayStatus} />
      )}
    </Box>
  );
}
