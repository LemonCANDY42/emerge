/**
 * CostMeter — per-agent token and USD usage.
 *
 * Sorted by USD descending; total at the bottom.
 * When no usage data has been recorded, shows a graceful message
 * rather than a table of zeros.
 */

import { Box, Text } from "ink";
import type React from "react";
import type { TuiState } from "../state/types.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatUsd(usd: number): string {
  if (usd === 0) return "$0.000";
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(3)}`;
}

interface CostMeterProps {
  readonly state: TuiState;
}

export function CostMeter({ state }: CostMeterProps): React.ReactElement {
  if (!state.hasUsageData) {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          Cost / Tokens
        </Text>
        <Text color="gray">(no token data recorded)</Text>
      </Box>
    );
  }

  // Sort by USD descending
  const rows = [...state.usage.values()].sort((a, b) => b.usd - a.usd);

  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        Cost / Tokens
      </Text>
      {rows.map((row) => (
        <Box key={String(row.agentId)}>
          <Text color="cyan">{String(row.agentId).padEnd(20)}</Text>
          <Text color="gray"> {formatUsd(row.usd).padEnd(10)}</Text>
          <Text color="gray">
            ({formatTokens(row.tokensIn)}in/{formatTokens(row.tokensOut)}out)
          </Text>
        </Box>
      ))}
      <Box>
        <Text bold>{"TOTAL".padEnd(20)}</Text>
        <Text bold color="yellow">
          {" "}
          {formatUsd(state.totalUsd)}
        </Text>
      </Box>
    </Box>
  );
}
