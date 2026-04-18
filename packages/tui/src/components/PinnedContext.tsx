/**
 * PinnedContext — shows items where decision.choice === "pin".
 *
 * v1 limitation: pinned items are sourced from `decision` events with
 * choice === "pin". A future M5 JSONL event kind will surface memory
 * recall pins more precisely. See docs/design/roadmap.md M5 section.
 */

import { Box, Text } from "ink";
import type React from "react";
import type { TuiState } from "../state/types.js";

function formatTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

interface PinnedContextProps {
  readonly state: TuiState;
}

export function PinnedContext({ state }: PinnedContextProps): React.ReactElement {
  const { pinned } = state;

  return (
    <Box flexDirection="column">
      <Text bold color="blue">
        Pinned Context
      </Text>
      {pinned.length === 0 ? (
        <Text color="gray">(no pinned items recorded in this session)</Text>
      ) : (
        pinned.map((item, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: pinned items have no stable id
          <Box key={idx} flexDirection="column">
            <Box>
              <Text color="gray">{formatTime(item.at)} </Text>
              <Text color="blue">[pin:{String(item.agent)}]</Text>
            </Box>
            <Box marginLeft={2}>
              <Text>{item.rationale}</Text>
            </Box>
          </Box>
        ))
      )}
    </Box>
  );
}
