/**
 * JSONL file-tailing primitive for the dashboard server.
 *
 * Functionally identical to packages/tui/src/parser.ts — the logic is
 * deliberately duplicated here rather than extracted to a shared package
 * for two reasons:
 *   1. @emerge/tui already has the right code; extracting to a third package
 *      would add indirection before a second concrete use-case demands it
 *      (per CLAUDE.md: "add when the second concrete use-case appears").
 *   2. The server runs in Node; the client (Vite) must never import Node
 *      fs/readline APIs. Keeping this file in the server subtree enforces
 *      that boundary at the filesystem level.
 *
 * If a third consumer of this code appears, factor into a `@emerge/jsonl-util`
 * package at that point.
 */

import { createReadStream, stat, unwatchFile, watchFile } from "node:fs";
import { parseJsonlLine } from "@emerge/kernel/contracts";
import type { JsonlEvent } from "@emerge/kernel/contracts";

const POLL_INTERVAL_MS = 250;

/**
 * Read all lines from a JSONL file, parse them, and return valid events.
 * Bad lines are logged to stderr and skipped.
 */
export async function readAllLines(filePath: string): Promise<readonly JsonlEvent[]> {
  return new Promise((resolve, reject) => {
    const events: JsonlEvent[] = [];
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    let buffer = "";

    stream.on("data", (chunk) => {
      buffer += String(chunk);
    });

    stream.on("end", () => {
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const result = parseJsonlLine(line);
        if (!result.ok) {
          process.stderr.write(`[dashboard] skipped bad JSONL line: ${result.error}\n`);
          continue;
        }
        events.push(result.event);
      }
      resolve(events);
    });

    stream.on("error", reject);
  });
}

/**
 * Tail a JSONL file, calling `onEvent` for each new valid event.
 * Uses fs.watchFile with a 250ms poll interval.
 *
 * @param startOffset - byte offset to start reading from (default 0).
 *   Pass the initial file size when you've already read the file once to
 *   avoid delivering events twice.
 *
 * Returns a `stop` function that unregisters the watcher.
 */
export function tailFile(
  filePath: string,
  onEvent: (event: JsonlEvent) => void,
  startOffset = 0,
): { stop: () => void } {
  let offset = startOffset;
  let partial = "";

  function readNewData(): void {
    stat(filePath, (statErr, stats) => {
      if (statErr) {
        // File may not exist yet — wait for next poll
        return;
      }

      if (stats.size < offset) {
        // File was truncated (e.g. log rotation or in-place replace).
        // Reset to the beginning so we don't miss events.
        offset = 0;
        partial = "";
      }

      if (stats.size <= offset) return;

      const stream = createReadStream(filePath, {
        encoding: "utf-8",
        start: offset,
        end: stats.size - 1,
      });

      let chunk = "";
      stream.on("data", (data) => {
        chunk += String(data);
      });
      stream.on("end", () => {
        offset = stats.size;
        const text = partial + chunk;
        partial = "";

        const lines = text.split("\n");
        // Last element may be incomplete (no trailing newline yet)
        const last = lines.pop() ?? "";
        partial = last;

        for (const line of lines) {
          if (!line.trim()) continue;
          const result = parseJsonlLine(line);
          if (!result.ok) {
            process.stderr.write(`[dashboard] skipped bad JSONL line: ${result.error}\n`);
            continue;
          }
          onEvent(result.event);
        }
      });
    });
  }

  // Initial read on start
  readNewData();

  // Poll every 250ms for new data
  watchFile(filePath, { interval: POLL_INTERVAL_MS, persistent: false }, readNewData);

  return {
    stop() {
      unwatchFile(filePath, readNewData);
    },
  };
}
