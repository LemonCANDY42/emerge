/**
 * @emerge/replay — InMemorySessionRecorder + JsonlReplayer + helpers.
 *
 * M3c2 update: makeRecorder() now writes per-event JSONL lines as they arrive
 * (conforming to the JSONL schema contract, ADR 0037), PLUS a session.start
 * line when start() is called and a session.end line when end() is called.
 * The old fat-record write (one JSON blob per session on end()) is removed
 * in favour of the streaming per-line format. See ADR 0037 for rationale.
 */

import type {
  ContractId,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMessage,
  RecordedEvent,
  ReplayCursor,
  Replayer,
  Result,
  SessionId,
  SessionRecord,
  SessionRecorder,
} from "@emerge/kernel/contracts";
import { fromRecordedEvent, sessionEndEvent, sessionStartEvent } from "@emerge/kernel/contracts";

export class InMemorySessionRecorder implements SessionRecorder {
  private readonly sessions = new Map<
    SessionId,
    { contractId: ContractId; startedAt: number; events: RecordedEvent[] }
  >();
  private _lastSessionId: SessionId | undefined;

  start(sessionId: SessionId, contract: ContractId): void {
    this.sessions.set(sessionId, {
      contractId: contract,
      startedAt: Date.now(),
      events: [],
    });
    this._lastSessionId = sessionId;
  }

  record(event: RecordedEvent): void {
    if (!this._lastSessionId) {
      // M8: programming error — start() was never called
      throw new Error("recorder.start() must be called before record()");
    }
    const session = this.sessions.get(this._lastSessionId);
    if (session) session.events.push(event);
  }

  async end(sessionId: SessionId): Promise<Result<SessionRecord>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        error: { code: "E_SESSION_NOT_FOUND", message: `session ${String(sessionId)} not found` },
      };
    }
    const record: SessionRecord = {
      sessionId,
      startedAt: session.startedAt,
      endedAt: Date.now(),
      contractRef: session.contractId,
      events: [...session.events],
      schemaVersion: "1",
    };
    return { ok: true, value: record };
  }
}

export class InMemoryReplayer implements Replayer {
  private readonly records = new Map<SessionId, SessionRecord>();

  addRecord(record: SessionRecord): void {
    this.records.set(record.sessionId, record);
  }

  async load(sessionId: SessionId): Promise<Result<SessionRecord>> {
    const record = this.records.get(sessionId);
    if (!record) {
      return {
        ok: false,
        error: {
          code: "E_NOT_FOUND",
          message: `session ${String(sessionId)} not in replayer`,
        },
      };
    }
    return { ok: true, value: record };
  }

  async next(
    cursor: ReplayCursor,
  ): Promise<Result<{ readonly cursor: ReplayCursor; readonly event: RecordedEvent | null }>> {
    const record = this.records.get(cursor.sessionId);
    if (!record) {
      return {
        ok: false,
        error: {
          code: "E_NOT_FOUND",
          message: `session ${String(cursor.sessionId)} not found`,
        },
      };
    }
    const event = record.events[cursor.index] ?? null;
    return {
      ok: true,
      value: {
        cursor: {
          sessionId: cursor.sessionId,
          index: cursor.index + (event !== null ? 1 : 0),
        },
        event,
      },
    };
  }
}

/**
 * RecordedProvider — wraps a SessionRecord and yields recorded provider_call
 * events in order, without ever prompting the real model.
 *
 * Conforms to the Provider contract. Throws E_REPLAY_EXHAUSTED when a fresh
 * invoke() arrives but all recorded provider_call events have been consumed.
 *
 * Use this when KernelConfig.reproducibility === "record-replay".
 */
export class RecordedProvider implements Provider {
  readonly capabilities: ProviderCapabilities;
  private readonly providerCalls: Array<readonly ProviderEvent[]>;
  private callIndex = 0;

  constructor(record: SessionRecord, originalCapabilities: ProviderCapabilities) {
    this.capabilities = originalCapabilities;
    // Extract provider_call events in recording order
    this.providerCalls = record.events
      .filter(
        (e): e is Extract<RecordedEvent, { kind: "provider_call" }> => e.kind === "provider_call",
      )
      .map((e) => e.events);
  }

  async *invoke(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const recorded = this.providerCalls[this.callIndex];
    if (recorded === undefined) {
      yield {
        type: "error",
        error: {
          code: "E_REPLAY_EXHAUSTED",
          message: `replay exhausted after ${this.callIndex} provider calls`,
          retriable: false,
        },
      };
      return;
    }
    this.callIndex++;
    for (const event of recorded) {
      yield event;
    }
  }

  async countTokens(_messages: readonly ProviderMessage[]): Promise<Result<number>> {
    return { ok: true, value: 0 };
  }
}

// Local type alias to avoid importing ProviderRequest twice
type ProviderRequest = Parameters<Provider["invoke"]>[0];

/**
 * Creates a recorder + optional file persistence.
 *
 * If filePath is provided:
 *   - Writes a "session.start" JSONL line when start() is called.
 *   - Appends one JSONL line per recorded event (per-event streaming, ADR 0037).
 *   - Writes a "session.end" JSONL line when end() is called.
 *
 * The old fat-record format (one JSON blob per session at end()) is replaced
 * by the per-line streaming format. Readers that relied on the fat-record must
 * migrate to line-by-line parsing. See ADR 0037.
 */
export function makeRecorder(options?: {
  filePath?: string;
}): SessionRecorder & { getLastRecord(): SessionRecord | undefined } {
  const inner = new InMemorySessionRecorder();
  let lastRecord: SessionRecord | undefined;

  // Lazily initialised file write helper (avoids Node import in non-Node envs)
  let writeLineFn: ((line: string) => void) | undefined;

  async function ensureWriter(fp: string): Promise<(line: string) => void> {
    if (writeLineFn) return writeLineFn;
    const { appendFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const dir = dirname(fp);
    if (dir) mkdirSync(dir, { recursive: true });
    writeLineFn = (line: string) => appendFileSync(fp, `${line}\n`, "utf-8");
    return writeLineFn;
  }

  return {
    start(sessionId, contract) {
      inner.start(sessionId, contract);
      if (options?.filePath) {
        // Fire-and-forget: write session.start line. Errors are non-fatal.
        const fp = options.filePath;
        void ensureWriter(fp).then((write) => {
          write(JSON.stringify(sessionStartEvent(sessionId, contract)));
        });
      }
    },
    record(event) {
      inner.record(event);
      if (options?.filePath) {
        const fp = options.filePath;
        const jsonlLine = JSON.stringify(fromRecordedEvent(event));
        void ensureWriter(fp).then((write) => {
          write(jsonlLine);
        });
      }
    },
    async end(sessionId) {
      const result = await inner.end(sessionId);
      if (!result.ok) return result;
      lastRecord = result.value;

      if (options?.filePath) {
        const fp = options.filePath;
        const write = await ensureWriter(fp);
        write(JSON.stringify(sessionEndEvent(sessionId)));
      }

      return result;
    },
    getLastRecord() {
      return lastRecord;
    },
  };
}
