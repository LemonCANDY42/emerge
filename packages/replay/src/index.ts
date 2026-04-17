/**
 * @emerge/replay — InMemorySessionRecorder + JsonlReplayer + helpers.
 */

import type {
  ContractId,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  RecordedEvent,
  ReplayCursor,
  Replayer,
  Result,
  SessionId,
  SessionRecord,
  SessionRecorder,
} from "@emerge/kernel/contracts";

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

/**
 * Creates a recorder + optional file persistence.
 * If filePath is provided, flushes the SessionRecord as JSONL on end().
 */
export function makeRecorder(options?: {
  filePath?: string;
}): SessionRecorder & { getLastRecord(): SessionRecord | undefined } {
  const inner = new InMemorySessionRecorder();
  let lastRecord: SessionRecord | undefined;

  return {
    start(sessionId, contract) {
      inner.start(sessionId, contract);
    },
    record(event) {
      inner.record(event);
    },
    async end(sessionId) {
      const result = await inner.end(sessionId);
      if (!result.ok) return result;
      lastRecord = result.value;

      if (options?.filePath) {
        // Lazy import fs to avoid breaking in environments without Node
        const { appendFileSync, mkdirSync } = await import("node:fs");
        const { dirname } = await import("node:path");
        const dir = dirname(options.filePath);
        if (dir) mkdirSync(dir, { recursive: true });
        appendFileSync(options.filePath, `${JSON.stringify(result.value)}\n`, "utf-8");
      }

      return result;
    },
    getLastRecord() {
      return lastRecord;
    },
  };
}
