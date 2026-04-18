/**
 * VerdictFeed — the M3d differentiator.
 *
 * Shows the latest 10 verdicts with color coding:
 *   aligned   → green  ✓
 *   partial   → yellow ?
 *   off-track → yellow ?
 *   failed    → red    ✗
 *
 * Timestamps are shown as HH:MM:SS.
 */

import { Box, Text } from "ink";
import type React from "react";
import type { TuiState, VerdictEntry, VerdictKind } from "../state/types.js";

const KIND_GLYPH: Record<VerdictKind, string> = {
  aligned: "✓",
  partial: "?",
  "off-track": "?",
  failed: "✗",
};

const KIND_COLOR: Record<VerdictKind, string> = {
  aligned: "green",
  partial: "yellow",
  "off-track": "yellow",
  failed: "red",
};

function formatTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

interface VerdictRowProps {
  readonly entry: VerdictEntry;
}

function VerdictRow({ entry }: VerdictRowProps): React.ReactElement {
  const colorStr: string = KIND_COLOR[entry.kind] ?? "white";
  const glyph = KIND_GLYPH[entry.kind] ?? "?";

  return (
    <Box>
      <Text color="gray">{formatTime(entry.at)} </Text>
      <Text color={colorStr}>{glyph} </Text>
      <Text color="gray">{String(entry.from)}: </Text>
      <Text color={colorStr}>{truncate(entry.rationale, 40)}</Text>
    </Box>
  );
}

interface VerdictFeedProps {
  readonly state: TuiState;
}

export function VerdictFeed({ state }: VerdictFeedProps): React.ReactElement {
  const { verdicts } = state;

  return (
    <Box flexDirection="column">
      <Text bold color="magenta">
        Verdict Feed
      </Text>
      {verdicts.length === 0 ? (
        <Text color="gray">(no verdicts yet)</Text>
      ) : (
        verdicts.map((entry, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: verdict entries have no stable id
          <VerdictRow key={idx} entry={entry} />
        ))
      )}
    </Box>
  );
}
