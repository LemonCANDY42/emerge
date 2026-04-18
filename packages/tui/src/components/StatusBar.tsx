/**
 * StatusBar — bottom bar showing live/replay mode status.
 *
 * Live mode: "[live] streaming • N events • kind histogram"
 * Replay mode: "[replay] event X / Y  ▶/⏸ playing/paused  cur kind=..."
 */

import { Box, Text } from "ink";
import type React from "react";
import type { TuiState } from "../state/types.js";

interface LiveStatusBarProps {
  readonly state: TuiState;
}

export function LiveStatusBar({ state }: LiveStatusBarProps): React.ReactElement {
  // Build a compact histogram string: kind(count) kind(count) ...
  const histParts: string[] = [];
  for (const [kind, count] of state.kindHistogram) {
    histParts.push(`${kind}(${count})`);
  }
  const hist = histParts.length > 0 ? histParts.join(" ") : "no events";

  return (
    <Box borderStyle="single" paddingX={1}>
      <Text bold color="green">
        [live]{" "}
      </Text>
      <Text color="green">streaming </Text>
      <Text color="gray">• {state.eventCount} events • </Text>
      <Text color="gray">{hist}</Text>
    </Box>
  );
}

export interface ReplayStatus {
  readonly cursor: number;
  readonly total: number;
  readonly playing: boolean;
  readonly currentKind: string;
}

interface ReplayStatusBarProps {
  readonly status: ReplayStatus;
}

export function ReplayStatusBar({ status }: ReplayStatusBarProps): React.ReactElement {
  const playIcon = status.playing ? "▶" : "⏸";
  const playText = status.playing ? "playing" : "paused";

  return (
    <Box borderStyle="single" paddingX={1}>
      <Text bold color="cyan">
        [replay]{" "}
      </Text>
      <Text>
        event {status.cursor} / {status.total}{" "}
      </Text>
      <Text color={status.playing ? "green" : "yellow"}>
        {playIcon} {playText}{" "}
      </Text>
      <Text color="gray">cur kind={status.currentKind}</Text>
      <Text color="gray"> ←/→ step · ↑/↓ jump10 · space toggle · q quit</Text>
    </Box>
  );
}
