/**
 * `emerge status` — read recent JSONL sessions from a configured directory
 * (default: ./.emerge/), print the last N sessions with topology summary +
 * total cost + adjudicator verdict.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseJsonlLine } from "@emerge/kernel/contracts";
import type { JsonlEvent } from "@emerge/kernel/contracts";

export interface StatusOptions {
  /** Directory to scan for JSONL session files. Default: ".emerge". */
  dir?: string;
  /** Maximum number of sessions to display. Default: 5. */
  last?: number;
}

async function readSessionEvents(filePath: string): Promise<JsonlEvent[]> {
  return new Promise((resolve) => {
    const events: JsonlEvent[] = [];
    try {
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const result = parseJsonlLine(line);
        if (result.ok) events.push(result.event);
      });
      rl.on("close", () => resolve(events));
      rl.on("error", () => resolve(events));
    } catch {
      resolve(events);
    }
  });
}

interface SessionSummary {
  filePath: string;
  sessionId: string;
  contractRef: string;
  startedAt: number;
  endedAt: number | undefined;
  eventCount: number;
  providerCallCount: number;
  toolCallCount: number;
  lifecycleCount: number;
  verdict: string;
  totalUsd: number;
}

function summarise(events: JsonlEvent[], filePath: string): SessionSummary | null {
  const start = events.find((e) => e.type === "session.start");
  if (!start || start.type !== "session.start") return null;

  const end = events.find((e) => e.type === "session.end");

  let totalUsd = 0;
  let providerCallCount = 0;
  let toolCallCount = 0;
  let lifecycleCount = 0;
  let verdict = "none";

  for (const e of events) {
    if (e.type === "provider_call") {
      providerCallCount++;
      // Extract USD from stop events in provider_call.events
      for (const pe of e.events) {
        if (pe.type === "stop") {
          totalUsd += pe.usage.usd;
        }
      }
    } else if (e.type === "tool_call") {
      toolCallCount++;
    } else if (e.type === "lifecycle") {
      lifecycleCount++;
    } else if (e.type === "span.end" && e.span.usage !== undefined) {
      // span.end events from telemetry carry usage
      totalUsd += e.span.usage.usd;
    }
  }

  // Verdict from adjudicator is not part of JSONL schema yet — show "implicit" for sessions
  // that used trustMode: "implicit"
  verdict = "implicit";

  return {
    filePath,
    sessionId: String(start.sessionId),
    contractRef: String(start.contractRef),
    startedAt: start.at,
    endedAt: end?.at,
    eventCount: events.length,
    providerCallCount,
    toolCallCount,
    lifecycleCount,
    verdict,
    totalUsd,
  };
}

export async function statusCommand(opts: StatusOptions = {}): Promise<void> {
  const dir = opts.dir ?? ".emerge";
  const last = opts.last ?? 5;

  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith("-session.jsonl") || f === "session.jsonl")
      .map((f) => path.join(dir, f));
  } catch {
    console.log(`[emerge status] No session directory found at "${dir}".`);
    console.log(`  Run "emerge run <blueprint.yaml>" to start a session.`);
    process.exit(0);
    return;
  }

  if (files.length === 0) {
    console.log(`[emerge status] No session files found in "${dir}".`);
    process.exit(0);
    return;
  }

  // Sort by mtime descending, take last N
  const withMtime = files
    .map((f) => {
      try {
        return { f, mtime: fs.statSync(f).mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, last)
    .map(({ f }) => f);

  const summaries: SessionSummary[] = [];
  for (const file of withMtime) {
    const events = await readSessionEvents(file);
    const summary = summarise(events, file);
    if (summary) summaries.push(summary);
  }

  if (summaries.length === 0) {
    console.log("[emerge status] No readable session summaries found.");
    process.exit(0);
    return;
  }

  console.log(`[emerge status] Last ${summaries.length} session(s) in "${dir}":\n`);

  for (const s of summaries) {
    const started = new Date(s.startedAt).toISOString();
    const wallMs = s.endedAt !== undefined ? s.endedAt - s.startedAt : null;
    console.log(`  Session:  ${s.sessionId}`);
    console.log(`  Contract: ${s.contractRef}`);
    console.log(`  Started:  ${started}`);
    if (wallMs !== null) console.log(`  Duration: ${wallMs}ms`);
    console.log(
      `  Events:   ${s.eventCount} (provider_calls: ${s.providerCallCount}, tool_calls: ${s.toolCallCount}, lifecycle: ${s.lifecycleCount})`,
    );
    console.log(`  Cost:     $${s.totalUsd.toFixed(6)}`);
    console.log(`  Verdict:  ${s.verdict}`);
    console.log(`  File:     ${s.filePath}`);
    console.log("");
  }

  process.exit(0);
}
