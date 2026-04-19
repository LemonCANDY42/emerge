/**
 * JSONL file parser for the TUI.
 *
 * Two modes:
 *   readAllLines(filePath)  — reads a file once, returns all events (for replay)
 *   tailFile(filePath, cb)  — watches for new lines, calls cb for each new event
 *
 * Bad lines are logged to stderr and skipped — they do not crash the consumer.
 */

import { createReadStream } from "node:fs";
import { stat, unwatchFile, watchFile } from "node:fs";
import { createInterface } from "node:readline";
import { parseJsonlLine } from "@lwrf42/emerge-kernel/contracts";
import type { JsonlEvent } from "@lwrf42/emerge-kernel/contracts";

const POLL_INTERVAL_MS = 250;

/**
 * Read all lines from a JSONL file, parse them, and return the valid events.
 * Invalid lines are logged to stderr and skipped.
 */
export async function readAllLines(filePath: string): Promise<readonly JsonlEvent[]> {
  return new Promise((resolve, reject) => {
    const events: JsonlEvent[] = [];
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      const result = parseJsonlLine(line);
      if (!result.ok) {
        process.stderr.write(`[tui] skipped bad JSONL line: ${result.error}\n`);
        return;
      }
      events.push(result.event);
    });

    rl.on("close", () => resolve(events));
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

/**
 * Tail a JSONL file, calling `onEvent` for each new valid event.
 * Uses fs.watchFile with a 250ms poll interval.
 *
 * Returns a `stop` function that unregisters the watcher.
 */
export function tailFile(
  filePath: string,
  onEvent: (event: JsonlEvent) => void,
): { stop: () => void } {
  let offset = 0;
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
        // The last element may be incomplete (no trailing newline yet)
        const last = lines.pop() ?? "";
        partial = last;

        for (const line of lines) {
          if (!line.trim()) continue;
          const result = parseJsonlLine(line);
          if (!result.ok) {
            process.stderr.write(`[tui] skipped bad JSONL line: ${result.error}\n`);
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
