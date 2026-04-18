/**
 * JsonlTelemetry — writes one JSON line per start/end/event to a file.
 *
 * Each line conforms to the JSONL event schema (ADR 0037):
 *   { v: "1.0.0", type: "span.start" | "span.end" | "span.event", at: number, ... }
 */

import fs from "node:fs";
import path from "node:path";
import type { SpanEnd, SpanId, SpanStart, Telemetry } from "@emerge/kernel/contracts";
import { spanEndEvent, spanEventEvent, spanStartEvent } from "@emerge/kernel/contracts";

export class JsonlTelemetry implements Telemetry {
  private readonly filePath: string;
  private readonly stream: fs.WriteStream;

  constructor(filePath = "./.emerge/telemetry.jsonl") {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: "a" });
  }

  start(span: SpanStart): void {
    this.write(spanStartEvent(span));
  }

  end(span: SpanEnd): void {
    this.write(spanEndEvent(span));
  }

  event(spanId: SpanId, name: string, attrs?: Readonly<Record<string, unknown>>): void {
    this.write(spanEventEvent(spanId, name, attrs));
  }

  close(): void {
    this.stream.end();
  }

  private write(obj: unknown): void {
    this.stream.write(`${JSON.stringify(obj)}\n`);
  }

  get path(): string {
    return this.filePath;
  }
}
