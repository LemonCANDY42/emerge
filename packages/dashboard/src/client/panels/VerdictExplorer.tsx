/**
 * VerdictExplorer — the differentiator panel.
 *
 * Shows contract-enforcement verdicts from Custodian/Adjudicator as first-class
 * UI elements. This is the primary visual separator from Mastra Agent Studio and
 * VoltAgent VoltOps which are workflow-focused and do not surface verdicts.
 *
 * Features:
 *   - Filter buttons: all / aligned / misaligned / uncertain
 *   - Expandable rows with full rationale + agent id + timestamp
 *   - Color-coded by verdict kind (matching TUI convention)
 *   - "No verdicts yet" placeholder
 */

import type { TuiState, VerdictEntry, VerdictKind } from "@emerge/tui/state";
import type React from "react";
import { useState } from "react";

interface VerdictExplorerProps {
  readonly state: TuiState;
}

type FilterKind = "all" | "aligned" | "misaligned" | "uncertain";

const KIND_BADGE: Record<VerdictKind, string> = {
  aligned: "ALIGNED",
  partial: "PARTIAL",
  "off-track": "OFF-TRACK",
  failed: "FAILED",
};

const KIND_CLASS: Record<VerdictKind, string> = {
  aligned: "bg-green-500/20 text-green-300 border border-green-500/40",
  partial: "bg-yellow-500/20 text-yellow-300 border border-yellow-500/40",
  "off-track": "bg-orange-500/20 text-orange-300 border border-orange-500/40",
  failed: "bg-red-500/20 text-red-300 border border-red-500/40",
};

const KIND_BORDER: Record<VerdictKind, string> = {
  aligned: "border-l-green-500",
  partial: "border-l-yellow-500",
  "off-track": "border-l-orange-500",
  failed: "border-l-red-500",
};

function filterVerdicts(
  verdicts: readonly VerdictEntry[],
  filter: FilterKind,
): readonly VerdictEntry[] {
  switch (filter) {
    case "aligned":
      return verdicts.filter((v) => v.kind === "aligned");
    case "misaligned":
      return verdicts.filter((v) => v.kind === "failed" || v.kind === "off-track");
    case "uncertain":
      return verdicts.filter((v) => v.kind === "partial");
    default:
      return verdicts;
  }
}

function formatTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

interface VerdictRowProps {
  readonly entry: VerdictEntry;
  readonly index: number;
}

function VerdictRow({ entry, index }: VerdictRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const borderColor = KIND_BORDER[entry.kind];
  const badgeClass = KIND_CLASS[entry.kind];
  const badge = KIND_BADGE[entry.kind];

  return (
    <div
      className={`border-l-2 ${borderColor} pl-3 py-2 cursor-pointer hover:bg-white/5 rounded-r`}
      onClick={() => setExpanded((e) => !e)}
      onKeyDown={(e) => e.key === "Enter" && setExpanded((x) => !x)}
      // biome-ignore lint/a11y/useSemanticElements: div with role button is intentional here for layout
      role="button"
      tabIndex={index}
      aria-expanded={expanded}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-gray-500 text-xs font-mono">{formatTime(entry.at)}</span>
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${badgeClass}`}>{badge}</span>
        <span className="text-gray-400 text-xs font-mono truncate max-w-32">
          {String(entry.from)}
        </span>
        <span className="text-gray-300 text-xs truncate flex-1">
          {expanded
            ? ""
            : entry.rationale.slice(0, 60) + (entry.rationale.length > 60 ? "\u2026" : "")}
        </span>
        <span className="text-gray-600 text-xs ml-auto">{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <div className="mt-2 text-gray-300 text-xs leading-relaxed whitespace-pre-wrap bg-gray-900 rounded p-2 border border-gray-700">
          <span className="text-gray-500 block mb-1">Agent: {String(entry.from)}</span>
          <span className="text-gray-500 block mb-1">Time: {new Date(entry.at).toISOString()}</span>
          <span className="text-gray-500 block mb-1">Kind: {entry.kind}</span>
          <hr className="border-gray-700 my-1" />
          <span className="text-gray-200">{entry.rationale}</span>
        </div>
      )}
    </div>
  );
}

export function VerdictExplorer({ state }: VerdictExplorerProps): React.ReactElement {
  const [filter, setFilter] = useState<FilterKind>("all");
  const { verdicts } = state;

  const filtered = filterVerdicts(verdicts, filter);

  const counts = {
    all: verdicts.length,
    aligned: verdicts.filter((v) => v.kind === "aligned").length,
    misaligned: verdicts.filter((v) => v.kind === "failed" || v.kind === "off-track").length,
    uncertain: verdicts.filter((v) => v.kind === "partial").length,
  };

  const filterButtons: { key: FilterKind; label: string }[] = [
    { key: "all", label: `All (${counts.all})` },
    { key: "aligned", label: `Aligned (${counts.aligned})` },
    { key: "misaligned", label: `Misaligned (${counts.misaligned})` },
    { key: "uncertain", label: `Uncertain (${counts.uncertain})` },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Section header — visually prominent */}
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-xs font-bold text-purple-400 uppercase tracking-wider">
          Verdict Explorer
        </h2>
        <span className="text-purple-600 text-xs">\u2014 contract enforcement</span>
      </div>

      {/* Filter buttons */}
      <div className="flex gap-1 flex-wrap mb-3">
        {filterButtons.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              filter === key
                ? "bg-purple-600/30 border-purple-500 text-purple-300"
                : "bg-transparent border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-400"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Verdict list */}
      <div className="flex-1 overflow-auto space-y-1">
        {verdicts.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-gray-600 text-sm">
            No verdicts yet
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-gray-600 text-sm">
            No verdicts match this filter
          </div>
        ) : (
          filtered.map((entry, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: verdict entries have no stable id
            <VerdictRow key={idx} entry={entry} index={idx} />
          ))
        )}
      </div>
    </div>
  );
}
