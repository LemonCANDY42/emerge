/**
 * `emerge replay <session.jsonl>` — replay a recorded session.
 *
 * Reads a session JSONL file written by makeRecorder({ filePath }), reconstructs
 * the SessionRecord from the per-event lines, then runs the session through a
 * kernel configured with reproducibility: "record-replay".
 *
 * The model is never re-prompted. Every provider_call result comes from the log.
 */

import fs from "node:fs";
import readline from "node:readline";
import type { AgentId, ContractId, SessionId } from "@emerge/kernel/contracts";
import { type JsonlEvent, parseJsonlLine } from "@emerge/kernel/contracts";
import type { ProviderEvent, RecordedEvent, SessionRecord } from "@emerge/kernel/contracts";
import { Kernel } from "@emerge/kernel/runtime";
import { MockProvider } from "@emerge/provider-mock";
import type { MockScriptEntry } from "@emerge/provider-mock";
import { RecordedProvider } from "@emerge/replay";

/**
 * Read all JSONL events from a file, skipping blank lines and lines that fail
 * to parse. Returns an array of successfully parsed JsonlEvents.
 */
async function readJsonlEvents(filePath: string): Promise<JsonlEvent[]> {
  return new Promise((resolve, reject) => {
    const events: JsonlEvent[] = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const result = parseJsonlLine(line);
      if (result.ok) {
        events.push(result.event);
      } else {
        // Non-fatal for replay — log and skip
        console.warn(`[emerge replay] Skipping unparseable line: ${result.error}`);
      }
    });
    rl.on("close", () => resolve(events));
    rl.on("error", reject);
  });
}

/**
 * Reconstruct a SessionRecord from an array of JsonlEvents.
 *
 * Looks for session.start and session.end events to build the record shell,
 * then converts provider_call, tool_call, surveillance_recommendation, decision,
 * lifecycle, and envelope events back into RecordedEvents.
 */
function reconstructSessionRecord(events: JsonlEvent[]): SessionRecord | null {
  const startEvent = events.find((e) => e.type === "session.start");
  if (!startEvent || startEvent.type !== "session.start") return null;

  const endEvent = events.find((e) => e.type === "session.end");

  const recordedEvents: RecordedEvent[] = [];
  for (const e of events) {
    switch (e.type) {
      case "envelope":
        recordedEvents.push({ kind: "envelope", at: e.at, envelope: e.envelope });
        break;
      case "provider_call":
        recordedEvents.push({ kind: "provider_call", at: e.at, req: e.req, events: e.events });
        break;
      case "tool_call":
        recordedEvents.push({ kind: "tool_call", at: e.at, call: e.call, result: e.result });
        break;
      case "surveillance_recommendation":
        recordedEvents.push({
          kind: "surveillance_recommendation",
          at: e.at,
          input: e.input,
          recommendation: e.recommendation,
        });
        break;
      case "decision":
        recordedEvents.push({
          kind: "decision",
          at: e.at,
          agent: e.agent,
          choice: e.choice,
          rationale: e.rationale,
        });
        break;
      case "lifecycle":
        recordedEvents.push({
          kind: "lifecycle",
          at: e.at,
          agent: e.agent,
          transition: e.transition,
        });
        break;
      default:
        // span.start, span.end, span.event, session.start, session.end — not RecordedEvents
        break;
    }
  }

  const record: SessionRecord = {
    sessionId: startEvent.sessionId,
    startedAt: startEvent.at,
    contractRef: startEvent.contractRef,
    events: recordedEvents,
    schemaVersion: "1",
    ...(endEvent !== undefined ? { endedAt: endEvent.at } : {}),
  };
  return record;
}

export async function replayCommand(sessionJsonlPath: string): Promise<void> {
  let events: JsonlEvent[];
  try {
    events = await readJsonlEvents(sessionJsonlPath);
  } catch (err) {
    console.error(`[emerge replay] Cannot read session file "${sessionJsonlPath}": ${String(err)}`);
    process.exit(1);
  }

  if (events.length === 0) {
    console.error(`[emerge replay] No parseable events in "${sessionJsonlPath}"`);
    process.exit(1);
  }

  const record = reconstructSessionRecord(events);
  if (!record) {
    console.error(
      `[emerge replay] Cannot reconstruct session: no session.start event found in "${sessionJsonlPath}"`,
    );
    process.exit(1);
  }

  console.log(`[emerge replay] Session: ${String(record.sessionId)}`);
  console.log(`[emerge replay] Events:  ${record.events.length}`);

  // Find the first lifecycle event to get the agent id, or use a default
  const lifecycleEvent = record.events.find((e) => e.kind === "lifecycle");
  const agentId = (
    lifecycleEvent?.kind === "lifecycle" ? lifecycleEvent.agent : "replay-agent"
  ) as AgentId;

  // Build a mock provider with a placeholder script (RecordedProvider overrides invoke())
  // The script needs at least one event so MockProvider validates OK
  const placeholderScript: MockScriptEntry[] = [
    {
      events: [
        {
          type: "stop",
          reason: "end_turn",
          usage: { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
        } as ProviderEvent,
      ],
    },
  ];
  const mockProvider = new MockProvider(placeholderScript, "mock");

  const kernel = new Kernel(
    {
      mode: "auto",
      reproducibility: "record-replay",
      lineage: { maxDepth: 4 },
      bus: { bufferSize: 256 },
      roles: {},
      trustMode: "implicit",
    },
    {
      replayRecord: record,
      replayProviderFactory: (rec, originalProvider) =>
        new RecordedProvider(rec, originalProvider.capabilities),
    },
  );

  kernel.mountProvider(mockProvider);
  kernel.setSession(record.sessionId, record.contractRef);

  const spawnResult = await kernel.spawn({
    id: agentId,
    role: "replay",
    description: "Replaying recorded session",
    provider: { kind: "static", providerId: "mock" },
    system: { kind: "literal", text: "Replaying." },
    toolsAllowed: [],
    memoryView: { inheritFromSupervisor: false, writeTags: [] },
    budget: { tokensIn: 100_000, tokensOut: 100_000, usd: 100 },
    termination: {
      maxIterations: 100,
      maxWallMs: 300_000,
      budget: { tokensIn: 100_000, tokensOut: 100_000 },
      retry: { transient: 0, nonRetryable: 0 },
      cycle: { windowSize: 100, repeatThreshold: 100 },
      done: { kind: "predicate", description: "end_turn" },
    },
    acl: {
      acceptsRequests: "any",
      acceptsQueries: "any",
      acceptsSignals: "any",
      acceptsNotifications: "any",
    },
    capabilities: {
      tools: [],
      modalities: ["text"],
      qualityTier: "standard",
      streaming: true,
      interrupts: false,
      maxConcurrency: 1,
    },
    lineage: { depth: 0 },
  });

  if (!spawnResult.ok) {
    console.error(`[emerge replay] Failed to spawn replay agent: ${spawnResult.error.message}`);
    process.exit(1);
  }

  await kernel.runAgent(spawnResult.value);
  const endResult = await kernel.endSession();

  if (!endResult.ok) {
    console.error(`[emerge replay] Session error: ${endResult.error.message}`);
    process.exit(1);
  }

  const snapshot = await spawnResult.value.snapshot();
  console.log(`[emerge replay] Replay complete. Agent state: ${snapshot.state}`);
  console.log(
    `[emerge replay] Tokens in: ${snapshot.usage.tokensIn}, out: ${snapshot.usage.tokensOut}`,
  );
  process.exit(0);
}
