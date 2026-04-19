/**
 * AgentRunner — implements AgentHandle and the perceive→decide→act→observe loop.
 */

import { createHash } from "node:crypto";
import type { ExperienceLibrary, ExperienceMatch } from "../contracts/experience.js";
import type {
  AgentCard,
  AgentHandle,
  AgentId,
  AgentSnapshot,
  AgentSpec,
  AgentState,
  ArtifactHandle,
  Bus,
  BusEnvelope,
  ContractError,
  ContractId,
  CorrelationId,
  CostMeter,
  Memory,
  MemoryItem,
  Provider,
  ProviderContent,
  ProviderEvent,
  ProviderMessage,
  Result,
  Sandbox,
  SandboxRequest,
  SchemaRef,
  SessionId,
  SignalKind,
  SpanId,
  Telemetry,
  ToolInvocation,
  ToolRegistry,
  ToolResult,
} from "../contracts/index.js";
import type { Budget, QuotaDecision } from "../contracts/index.js";
import type { SessionRecorder } from "../contracts/replay.js";
import type { AssessmentInput, StepProfile, Surveillance } from "../contracts/surveillance.js";
import { correctToolCall } from "./correction.js";
import { runDecomposition } from "./decomposition.js";
import type { VerificationConfig } from "./kernel.js";
import type { Scheduler } from "./scheduler.js";
import type { SchemaAdapterRegistry } from "./schema-adapter.js";
import { maybeApplyTruncationNotice } from "./truncation.js";

export interface AgentRunnerDeps {
  spec: AgentSpec;
  provider: Provider;
  toolRegistry: ToolRegistry;
  sandbox: Sandbox;
  memory: Memory;
  bus: Bus;
  scheduler: Scheduler;
  sessionId: SessionId;
  correlationId: CorrelationId;
  contractId?: ContractId | undefined;
  telemetry?: Telemetry | undefined;
  recorder?: SessionRecorder | undefined;
  costMeter?: CostMeter | undefined;
  surveillance?: Surveillance | undefined;
  /** Callback so CalibratedSurveillance can stash the last assessed context for observe(). */
  surveillanceNotify?:
    | ((agentId: AgentId, providerId: string, difficulty: StepProfile["difficulty"]) => void)
    | undefined;
  /** Lineage maxDepth from KernelConfig — needed for decomposition guard. */
  lineageMaxDepth?: number | undefined;
  /**
   * Optional experience library. When present, hints are fetched before assess()
   * and passed as experienceHints. Without a mounted library, hints are undefined,
   * which is honest — surveillance proceeds without priors.
   */
  experienceLibrary?: ExperienceLibrary | undefined;
  /** M3b: schema adapter registry for per-provider tool spec shaping. */
  schemaAdapterRegistry?: SchemaAdapterRegistry | undefined;
  /** M3b: post-step verification config (opt-in). */
  verification?: VerificationConfig | undefined;
  /** M3b: adjudicator agent id from KernelConfig.roles — used for verification routing. */
  adjudicatorId?: AgentId | undefined;
  /**
   * Session mode from KernelConfig. When set to "auto" or "bypass", the agent-runner
   * skips the per-tool defaultMode="ask" human-prompt path (which would otherwise
   * deadlock for autonomous sessions like CI / eval / unattended runs).
   * Tools with defaultMode="deny" are still hard-denied regardless of session mode.
   * Default: "auto" (autonomous), matching the most common emerge use case.
   * See ADR 0008 (operating modes) for the mode-vs-tool-permission semantics.
   */
  sessionMode?: string | undefined;
}

function makeCard(spec: AgentSpec, provider: Provider): AgentCard {
  return {
    id: spec.id,
    role: spec.role,
    description: spec.description ?? spec.role,
    capabilities: spec.capabilities,
    io: {
      accepts: {
        "~standard": { version: 1, vendor: "emerge", validate: (v) => ({ value: v }) },
      } as SchemaRef,
      produces: {
        "~standard": { version: 1, vendor: "emerge", validate: (v) => ({ value: v }) },
      } as SchemaRef,
    },
    budget: spec.budget,
    termination: spec.termination,
    acl: spec.acl,
    lineage: spec.lineage,
  };
}

export class AgentRunner implements AgentHandle {
  readonly id: AgentId;
  private readonly deps: AgentRunnerDeps;
  private readonly agentCard: AgentCard;
  private _state: AgentState = "idle";
  /** Last terminal error observed by this agent (e.g. provider 502). Surfaced via lastError(). */
  private _lastError:
    | { code: string; message: string; cause?: unknown; retriable?: boolean }
    | undefined;
  private readonly snapshotListeners: Array<(s: AgentSnapshot) => void> = [];
  private _lastActivityAt = Date.now();
  // In-memory artifact store for to_handle projections
  private readonly artifactStore = new Map<ArtifactHandle, string>();
  private artifactCounter = 0;
  // C1/C2: inbox queue for request envelopes arriving before or during run().
  // The subscription is opened in openInbox() which Kernel.spawn() calls immediately
  // after construction — before returning the handle to callers. This ensures any
  // bus.send(request) that follows spawn() is never missed.
  private readonly _inboxQueue: Array<{ payload: unknown; correlationId: CorrelationId }> = [];
  /** C1: inbox subscription — opened by openInbox() called from Kernel.spawn(). */
  private _inboxSub: import("../contracts/index.js").Subscription | null = null;
  /** C3: quota subscription — opened by openInbox() called from Kernel.spawn(). */
  private _quotaSub: import("../contracts/index.js").Subscription | null = null;
  /** m7: count of envelopes dropped due to back-pressure; warn on first drop. */
  private _inboxDropsWarned = false;

  constructor(deps: AgentRunnerDeps) {
    this.deps = deps;
    this.id = deps.spec.id;
    this.agentCard = makeCard(deps.spec, deps.provider);
  }

  /**
   * C1/C2: Open inbox and quota subscriptions immediately after construction.
   * Must be called by Kernel.spawn() before returning the handle so that any
   * bus.send(request) from the caller cannot race ahead of the subscription.
   *
   * run() drains the already-open subscriptions rather than opening new ones.
   */
  openInbox(): void {
    const { bus } = this.deps;

    // Inbox: queue request/query envelopes addressed to this agent.
    this._inboxSub = bus.subscribe(this.id, { kind: "self" });
    const inboxSub = this._inboxSub;
    // m7: capture a reference to the droppedCount getter if the bus exposes it.
    const inboxDropRef = inboxSub as { readonly droppedCount?: number };
    void (async () => {
      for await (const env of inboxSub.events) {
        // m7: warn once on first observed back-pressure drop in inbox.
        const dropped = inboxDropRef.droppedCount ?? 0;
        if (dropped > 0 && !this._inboxDropsWarned) {
          this._inboxDropsWarned = true;
          console.warn(
            `[emerge] inbox dropped envelopes due to back-pressure: ${dropped} (agent: ${this.id}). M3c2 will surface this in telemetry.`,
          );
        }
        if (env.kind === "request" || env.kind === "query") {
          if (env.to.kind === "agent" && env.to.id === this.id) {
            const payload = (env as { payload?: unknown }).payload;
            if (payload !== undefined && payload !== null) {
              this._inboxQueue.push({
                payload,
                correlationId: env.correlationId,
              });
            }
          }
        }
      }
    })();

    // Quota: apply grant/partial envelopes addressed to this agent immediately.
    this._quotaSub = bus.subscribe(this.id, { kind: "self" });
    const quotaSub = this._quotaSub;
    void (async () => {
      for await (const env of quotaSub.events) {
        if (
          (env.kind === "quota.grant" || env.kind === "quota.partial") &&
          env.to.kind === "agent" &&
          env.to.id === this.id
        ) {
          this.applyQuotaGrant(env.decision);
          console.log(
            `[agent-runner:${this.id}] Received ${env.kind} — budget updated (tokensOut: ${env.decision.kind !== "deny" ? (env.decision.granted.tokensOut ?? "unchanged") : "n/a"})`,
          );
        } else if (env.kind === "quota.deny" && env.to.kind === "agent" && env.to.id === this.id) {
          // C3: on deny, terminate via abortController — schedState will be set in run()
          // We store the signal but can't abort now without schedState; run() checks it.
          // Use a flag instead so run() sees the deny when it starts.
          console.log(`[agent-runner:${this.id}] quota.deny received before run() — will abort`);
          this._quotaDeniedBeforeRun = true;
        }
      }
    })();
  }

  /** C1: set when quota.deny arrives before run() starts. run() aborts on sight. */
  private _quotaDeniedBeforeRun = false;

  /** C1: close both subscriptions opened by openInbox(). Called at all terminal paths. */
  private closeInbox(): void {
    this._inboxSub?.close();
    this._quotaSub?.close();
    this._inboxSub = null;
    this._quotaSub = null;
  }

  card(): AgentCard {
    return this.agentCard;
  }

  /**
   * Optional: returns the last terminal error this agent observed, if any.
   * Useful for demos / dashboards to surface upstream-provider failures
   * (auth errors, gateway 502s, model refusals) instead of just reporting
   * "state: failed" with no context.
   */
  lastError(): { code: string; message: string; cause?: unknown; retriable?: boolean } | undefined {
    return this._lastError;
  }

  /**
   * D: Apply a quota grant from the Custodian by expanding the agent's budget.
   * Must be called atomically before the next scheduler.preStep() invocation.
   * Merges granted dimensions additively into the current TerminationPolicy.budget.
   */
  applyQuotaGrant(decision: QuotaDecision): void {
    if (decision.kind === "deny") return;
    const { granted } = decision;
    const current = this.deps.spec.termination.budget;
    const updated: Budget = {
      ...(current.tokensIn !== undefined || granted.tokensIn !== undefined
        ? { tokensIn: (current.tokensIn ?? 0) + (granted.tokensIn ?? 0) }
        : {}),
      ...(current.tokensOut !== undefined || granted.tokensOut !== undefined
        ? { tokensOut: (current.tokensOut ?? 0) + (granted.tokensOut ?? 0) }
        : {}),
      ...(current.wallMs !== undefined || granted.wallMs !== undefined
        ? { wallMs: (current.wallMs ?? 0) + (granted.wallMs ?? 0) }
        : {}),
      ...(current.usd !== undefined || granted.usd !== undefined
        ? { usd: (current.usd ?? 0) + (granted.usd ?? 0) }
        : {}),
    };
    // Mutate via the scheduler's in-process state (safe; single-threaded JS)
    const schedState = this.deps.scheduler.get(this.id);
    if (schedState) {
      schedState.policy = { ...schedState.policy, budget: updated };
    }
    // Also update the spec reference so subsequent card() calls reflect the grant
    (this.deps.spec as { termination: { budget: Budget } }).termination.budget = updated;
  }

  async send(envelope: BusEnvelope): Promise<Result<void, ContractError>> {
    return this.deps.bus.send(envelope);
  }

  async snapshot(): Promise<AgentSnapshot> {
    const sched = this.deps.scheduler.get(this.id);
    return {
      id: this.id,
      state: this._state,
      usage: sched?.usage ?? { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 },
      lastActivityAt: this._lastActivityAt,
    };
  }

  async *events(): AsyncIterable<AgentSnapshot> {
    // Simplified: yield current snapshot; real impl would push on state changes.
    yield await this.snapshot();
  }

  /**
   * Run the perceive → decide → act → observe loop until termination.
   *
   * C1/C2: The inbox and quota subscriptions were opened by openInbox() during
   * Kernel.spawn(). run() only drains the already-open queues; it does NOT open
   * new subscriptions, so no race between spawn→send→run is possible.
   */
  async run(): Promise<void> {
    const { spec, scheduler, sessionId, correlationId, bus } = this.deps;

    // C1: if openInbox() was never called (e.g. test harnesses that bypass Kernel.spawn),
    // open the subscriptions lazily so tests still work.
    if (this._inboxSub === null) {
      this.openInbox();
    }

    const schedState = scheduler.register(spec.id, spec.termination);
    // Track which projection kinds have already emitted their one-time warn.
    const warnedProjections = new Set<string>();

    // C1: if quota.deny arrived before run() started, abort immediately.
    if (this._quotaDeniedBeforeRun) {
      console.log(`[agent-runner:${this.id}] quota.deny was received before run() — aborting`);
      schedState.abortController.abort();
    }

    // Wire the quota deny path into schedState now that we have it.
    // The openInbox() loop handles grant/partial; deny aborts the controller.
    // Re-open a dedicated one-shot listener for deny (the existing quotaSub already handles it
    // via the flag above for pre-run case; for mid-run we need to abort directly).
    // Instead of opening another subscription, we simply check the flag and re-check on abort.
    // The simplest approach: keep checking schedState.abortController in the existing quota loop.
    // Since openInbox() already handles quota.deny by setting _quotaDeniedBeforeRun,
    // we add a one-shot bus subscriber specifically for mid-run quota.deny.
    const midRunQuotaDenySub = bus.subscribe(this.id, { kind: "self" });
    void (async () => {
      for await (const env of midRunQuotaDenySub.events) {
        if (env.kind === "quota.deny" && env.to.kind === "agent" && env.to.id === this.id) {
          console.log(`[agent-runner:${this.id}] quota.deny received — terminating`);
          schedState.abortController.abort();
          midRunQuotaDenySub.close();
          return;
        }
      }
    })();

    this.setState("thinking");

    // Working memory: start with system prompt
    const messages: ProviderMessage[] = [];
    if (spec.system.kind === "literal") {
      messages.push({ role: "system", content: spec.system.text });
    }

    // Fetch initial memory — M12: honour memoryView scope
    // By default sub-agents only see their own memory (no inherit from supervisor).
    const memAgents = spec.memoryView.inheritFromSupervisor
      ? undefined // undefined = all agents visible
      : [this.id];
    const memQuery = spec.memoryView.readFilter ? { attributes: spec.memoryView.readFilter } : {};
    const memResult = await this.deps.memory.recall(
      memQuery,
      { session: sessionId, ...(memAgents !== undefined ? { agents: memAgents } : {}) },
      { maxItems: 20 },
    );
    if (memResult.ok) {
      for (const item of memResult.value.items) {
        messages.push({ role: "user", content: [{ type: "text", text: item.content }] });
      }
    }

    // Resolve available tools
    const tools = this.deps.toolRegistry.resolve(spec.toolsAllowed);

    // M2: monotonic delta seq per request — reset for each provider call
    let deltaSeq = 0;
    // M2: track how many times this agent has triggered decomposition in this run
    let localDecompositionCount = 0;

    while (true) {
      const stepResult = scheduler.preStep(schedState, sessionId, correlationId);
      if (!stepResult.continue) {
        this.setState("completed");
        await bus.send({
          kind: "result",
          correlationId,
          sessionId,
          from: this.id,
          to: { kind: "broadcast" },
          timestamp: Date.now(),
          payload: { reason: stepResult.reason, state: "completed" },
        });
        break;
      }

      if (schedState.abortController.signal.aborted) {
        this.setState("failed");
        // C5: always emit a terminal result envelope on abort so topology helpers don't hang
        await bus.send({
          kind: "result",
          correlationId,
          sessionId,
          from: this.id,
          to: { kind: "broadcast" },
          timestamp: Date.now(),
          payload: {
            error: { code: "E_ABORTED", message: "Agent aborted" },
            stopReason: "aborted",
          },
        });
        break;
      }

      // A3: Drain the inbox queue — inject any pending request payloads as user messages.
      // This is how topology helpers (supervisorWorker, workerPool, pipeline) deliver tasks:
      // they send a `request` envelope on the bus; the runner picks it up here and treats
      // the payload as the task input for this iteration.
      while (this._inboxQueue.length > 0) {
        const item = this._inboxQueue.shift();
        if (item !== undefined) {
          const text =
            typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload);
          messages.push({
            role: "user",
            content: [{ type: "text", text }],
          });
        }
      }

      this.setState("thinking");

      // --- M2: Surveillance assessment before each step ---
      // Effective depth = spawned depth + how many decompositions this agent has run
      const decompositionDepth = (spec.lineage.depth ?? 0) + localDecompositionCount;

      // Build a synthetic StepProfile for this iteration.
      // Constructed here (outside the surveillance guard) so the experience hint
      // fetch can run regardless of whether full surveillance is active — this
      // closes the postmortem→experience→hint loop even in demos that don't mount
      // a Surveillance instance. See ADR 0038.
      const stepProfile: StepProfile = {
        stepId: `${this.id}-step-${schedState.iteration}`,
        difficulty: "medium", // default; callers may set spec.surveillance with richer context
        goal: spec.system.kind === "literal" ? spec.system.text.slice(0, 200) : "agent task",
        tools: spec.toolsAllowed as readonly string[],
      };

      // Fetch experience hints whenever a library is mounted — skip on error so
      // the hot path is never blocked by a non-critical hint failure.
      // taskType uses contractId (stable across sessions of the same task) so the
      // query key always agrees with what defaultAnalyze stores. See ADR 0038.
      let experienceHints: ExperienceMatch[] | undefined;
      if (this.deps.experienceLibrary) {
        const hintResult = await this.deps.experienceLibrary.hint(
          {
            taskType:
              this.deps.contractId !== undefined
                ? String(this.deps.contractId)
                : stepProfile.goal.slice(0, 50),
            description: stepProfile.goal,
          },
          { maxItems: 5, maxTokens: 1000 },
        );
        if (hintResult.ok) {
          experienceHints = [...hintResult.value];
        }
      }

      if (
        this.deps.surveillance &&
        (spec.surveillance === "active" || spec.surveillance === "strict")
      ) {
        const assessInput: AssessmentInput = {
          agent: this.id,
          providerId: this.deps.provider.capabilities.id,
          capabilities: this.deps.provider.capabilities,
          step: stepProfile,
          decompositionDepth,
          ...(experienceHints !== undefined ? { experienceHints } : {}),
        };

        this.deps.surveillanceNotify?.(
          this.id,
          this.deps.provider.capabilities.id,
          stepProfile.difficulty,
        );

        // G: emit progress before surveillance assess
        await bus.send({
          kind: "progress",
          correlationId,
          sessionId,
          from: this.id,
          to: { kind: "broadcast" },
          timestamp: Date.now(),
          step: `surveillance.assess:${stepProfile.stepId}`,
          note: `difficulty=${stepProfile.difficulty}`,
        });

        const recommendation = await this.deps.surveillance.assess(assessInput);

        if (this.deps.recorder) {
          this.deps.recorder.record({
            kind: "surveillance_recommendation",
            at: Date.now(),
            input: assessInput,
            recommendation,
          });
        }

        if (recommendation.kind === "decompose") {
          localDecompositionCount++;
          // Opaque adaptive decomposition path
          const decompResult = await runDecomposition({
            step: stepProfile,
            decompositionDepth,
            lineageConfig: { maxDepth: this.deps.lineageMaxDepth ?? 4 },
            provider: this.deps.provider,
            parentMessages: [...messages],
            signal: schedState.abortController.signal,
          });

          console.log(
            `[surveillance] decomposed step into ${decompResult.subStepCount} sub-steps: ${decompResult.subStepGoals.join(" | ")}`,
          );

          // Inject combined result as a plain user text message — portable shape that
          // avoids requiring a paired tool_use block (which any real provider would reject).
          messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: `Decomposition complete. Combined result: ${decompResult.combinedResult.preview}`,
              },
            ],
          });

          await this.deps.surveillance.observe({
            stepId: stepProfile.stepId,
            agent: this.id,
            success: decompResult.combinedResult.ok,
            retries: 0,
            toolErrors: 0,
            selfCorrections: 0,
            wallMs: 0,
            costOvershoot: 1.0,
          });

          // Continue loop — the injected result will inform the next provider call
          continue;
        }

        if (recommendation.kind === "scaffold") {
          // Inject scaffold additions as a system message append
          for (const addition of recommendation.additions) {
            messages.push({
              role: "user",
              content: [{ type: "text", text: `[scaffold:${addition.kind}] ${addition.content}` }],
            });
          }
          console.log(`[surveillance] scaffolding injected: ${recommendation.rationale}`);
          // Proceed with the scaffolded context
        }

        if (recommendation.kind === "escalate") {
          // M2: log and treat as proceed (router is M3+)
          console.log(`[surveillance] escalation deferred (M3+): ${recommendation.rationale}`);
        }

        if (recommendation.kind === "defer") {
          // 1. Emit human.request so the orchestrator/UI can act on it.
          await bus.send({
            kind: "human.request",
            correlationId,
            sessionId,
            from: this.id,
            to: { kind: "broadcast" },
            timestamp: Date.now(),
            prompt: recommendation.checkpoint,
          });
          console.log(`[surveillance] waiting for human input: ${recommendation.checkpoint}`);

          // 2. Block until a correlated human.reply or human.timeout arrives.
          this.setState("waiting_for_human");
          const humanTimeout = spec.termination.maxWallMs;
          const humanSub = bus.subscribe(this.id, { kind: "self" });
          let humanResolved = false;

          const humanWait = new Promise<"replied" | "timeout">((resolve) => {
            const timer = setTimeout(() => {
              if (!humanResolved) resolve("timeout");
            }, humanTimeout);

            void (async () => {
              for await (const env of humanSub.events) {
                if (schedState.abortController.signal.aborted) {
                  clearTimeout(timer);
                  resolve("timeout");
                  return;
                }
                if (env.correlationId !== correlationId) continue;
                if (env.kind === "human.reply") {
                  clearTimeout(timer);
                  // Inject the human reply as a user text message.
                  const replyText =
                    typeof env.reply === "string" ? env.reply : JSON.stringify(env.reply);
                  messages.push({
                    role: "user",
                    content: [{ type: "text", text: replyText }],
                  });
                  resolve("replied");
                  return;
                }
                if (env.kind === "human.timeout") {
                  clearTimeout(timer);
                  resolve("timeout");
                  return;
                }
              }
              clearTimeout(timer);
              resolve("timeout");
            })();
          });

          const humanOutcome = await humanWait;
          humanResolved = true;
          humanSub.close();

          if (humanOutcome === "timeout") {
            // 3. Terminate with stopReason human_timeout — do not call provider.
            this.setState("completed");
            await bus.send({
              kind: "result",
              correlationId,
              sessionId,
              from: this.id,
              to: { kind: "broadcast" },
              timestamp: Date.now(),
              payload: { reason: "human_timeout", checkpoint: recommendation.checkpoint },
            });
            this.closeInbox();
            midRunQuotaDenySub.close();
            return;
          }
          // If replied, fall through — the injected reply text will be in messages
          // and the outer loop will call the provider on the next iteration.
          continue;
        }
      }
      // --- end surveillance ---

      // Build provider tool specs — apply per-provider schema adapter if mounted
      const providerId = this.deps.provider.capabilities.id;
      const providerTools = tools.map((t) => ({
        name: t.spec.name,
        description: t.spec.description,
        inputSchema: this.deps.schemaAdapterRegistry
          ? this.deps.schemaAdapterRegistry.adapt(
              t.spec,
              providerId as import("../contracts/provider.js").ProviderId,
            )
          : (t.spec.jsonSchema ?? { type: "object" as const }),
      }));

      const req: import("../contracts/index.js").ProviderRequest = {
        messages: [...messages],
        ...(providerTools.length > 0 ? { tools: providerTools } : {}),
        signal: schedState.abortController.signal,
      };

      // M2: reset delta seq at start of each provider call
      deltaSeq = 0;

      const callStart = Date.now();
      let textAccumulator = "";
      const pendingToolCalls = new Map<string, { name: string; inputJson: string }>();
      const completedToolCalls: Array<{
        toolCallId: string;
        name: string;
        input: unknown;
        result: ToolResult;
      }> = [];
      let stopUsage = { tokensIn: 0, tokensOut: 0, wallMs: 0, toolCalls: 0, usd: 0 };
      let stopReason = "end_turn";
      const recordedEvents: ProviderEvent[] = [];

      for await (const event of this.deps.provider.invoke(req)) {
        recordedEvents.push(event);

        if (schedState.abortController.signal.aborted) break;

        if (event.type === "text_delta") {
          textAccumulator += event.text;
          // M2: increment seq monotonically per correlationId
          await bus.send({
            kind: "delta",
            correlationId,
            sessionId,
            from: this.id,
            to: { kind: "broadcast" },
            timestamp: Date.now(),
            chunk: event.text,
            seq: deltaSeq++,
          });
        } else if (event.type === "tool_call_start") {
          pendingToolCalls.set(event.toolCallId, { name: event.name, inputJson: "" });
        } else if (event.type === "tool_call_input_delta") {
          const tc = pendingToolCalls.get(event.toolCallId);
          if (tc) tc.inputJson += event.partial;
        } else if (event.type === "tool_call_end") {
          // nothing to do here; we process on stop
        } else if (event.type === "stop") {
          stopUsage = event.usage;
          stopReason = event.reason;
        } else if (event.type === "error") {
          this.setState("failed");
          // Surface the actual provider error message so demos / dashboards / tests
          // can show the cause (was previously a generic "Provider returned an error event"
          // that hid useful info like Cloudflare 502s, auth failures, etc.).
          this._lastError = event.error;
          // C5: emit terminal result envelope on provider error
          await bus.send({
            kind: "result",
            correlationId,
            sessionId,
            from: this.id,
            to: { kind: "broadcast" },
            timestamp: Date.now(),
            payload: {
              error: event.error,
              stopReason: "failed",
            },
          });
          this.closeInbox();
          midRunQuotaDenySub.close();
          return;
        }
      }

      if (this.deps.recorder) {
        this.deps.recorder.record({
          kind: "provider_call",
          at: callStart,
          req,
          events: recordedEvents,
        });
      }

      // M1: fingerprint the provider call for cycle detection
      const promptHash = createHash("sha256").update(JSON.stringify(req.messages)).digest("hex");
      schedState.cycleGuard.recordProviderCall(
        this.id,
        this.deps.provider.capabilities.id,
        promptHash,
      );

      // C3: record provider cost in the cost meter
      if (this.deps.costMeter && stopUsage.usd > 0) {
        this.deps.costMeter.record({
          agent: this.id,
          ...(this.deps.contractId !== undefined ? { contract: this.deps.contractId } : {}),
          category: "provider",
          usd: stopUsage.usd,
        });
      }

      scheduler.recordUsage(schedState, stopUsage);
      this._lastActivityAt = Date.now();

      // --- M2: Surveillance observe after each step ---
      if (this.deps.surveillance) {
        const stepFailed = stopReason === "error";
        const cycleHits = schedState.cycleGuard.shouldInterrupt(this.id) ? 1 : 0;
        // forecast: use costMeter if available; else treat forecast = actual
        const forecastUsd = this.deps.costMeter
          ? this.deps.costMeter.forecast({
              agent: this.id,
              description: "step forecast",
              tokenEstimateIn: stopUsage.tokensIn,
              tokenEstimateOut: stopUsage.tokensOut,
            }).p50
          : stopUsage.usd;
        const costOvershoot = forecastUsd > 0 ? stopUsage.usd / forecastUsd : 1.0;

        await this.deps.surveillance.observe({
          stepId: `${this.id}-step-${schedState.iteration}`,
          agent: this.id,
          success: !stepFailed,
          retries: 0,
          toolErrors: 0,
          selfCorrections: 0,
          wallMs: stopUsage.wallMs,
          costOvershoot,
          cycleHits,
        });
      }
      // --- end surveillance observe ---

      // Pre-compute corrected inputs for all pending tool calls.
      // We do this BEFORE building the assistant message so that the message
      // echoed back to the model and the cycle-guard fingerprint both reflect
      // the corrected (dispatched) input, not the raw model output.
      // ADR 0034 correction telemetry is emitted here at the single site where
      // correction happens (previously was emitted in the execution loop).
      // See M3c2 review finding #4.
      const correctedInputs = new Map<string, unknown>();
      for (const [toolCallId, tc] of pendingToolCalls) {
        let originalParsed: unknown = {};
        try {
          originalParsed = JSON.parse(tc.inputJson || "{}");
        } catch {
          originalParsed = {};
        }
        const tool = this.deps.toolRegistry.get(tc.name);
        if (tool) {
          const baseInv: import("../contracts/index.js").ToolInvocation = {
            toolCallId: toolCallId as never,
            callerAgent: this.id,
            name: tc.name,
            input: originalParsed,
            signal: schedState.abortController.signal,
          };
          const { call: correctedInv, fixes } = correctToolCall(baseInv, tool.spec.jsonSchema);
          // ADR 0034: emit correction telemetry at the point of correction.
          if (fixes.length > 0 && this.deps.telemetry) {
            const corrSpanId = `tool-correction-${toolCallId}` as SpanId;
            this.deps.telemetry.event(corrSpanId, "tool_call.corrected", {
              fixes: JSON.stringify(fixes),
            });
          }
          correctedInputs.set(toolCallId, correctedInv.input);
        } else {
          correctedInputs.set(toolCallId, originalParsed);
        }
      }

      // C2: Append assistant message FIRST — the model must see its own output
      // before the verifier's reaction (ordering: assistant(X) → user(verdict) → user(toolresults))
      const assistantContent: ProviderContent[] = [];
      if (textAccumulator) {
        assistantContent.push({ type: "text", text: textAccumulator });
      }
      for (const [toolCallId, tc] of pendingToolCalls) {
        // Use corrected input so the model's own history matches what was dispatched.
        assistantContent.push({
          type: "tool_use",
          toolCallId,
          name: tc.name,
          input: correctedInputs.get(toolCallId) ?? {},
        });
      }

      if (assistantContent.length > 0) {
        messages.push({ role: "assistant", content: assistantContent });
      }

      // Append to memory
      if (textAccumulator) {
        await this.deps.memory.append([
          {
            tier: "working",
            content: textAccumulator,
            attributes: { role: "assistant", agent: this.id },
          },
        ]);
      }

      // --- M3b: per-step verification (opt-in via VerificationConfig) ---
      // C2: runs AFTER assistant message is appended; C3: aligned with ADR 0032
      const verif = this.deps.verification;
      if (verif && verif.mode === "per-step") {
        const verifierId = verif.verifier ?? this.deps.adjudicatorId;
        if (verifierId) {
          // Send a verdict-request envelope to the verifier and inject the response
          // as a user message into working memory so the next step sees it.
          const verdictCorrId =
            `verdict-${this.id}-${schedState.iteration}-${Date.now()}` as CorrelationId;
          const verdictSub = bus.subscribe(this.id, {
            kind: "from",
            sender: verifierId,
            kinds: ["verdict"],
          });

          await bus.send({
            kind: "request",
            correlationId: verdictCorrId,
            sessionId,
            from: this.id,
            to: { kind: "agent", id: verifierId },
            timestamp: Date.now(),
            payload: {
              type: "verdict_request",
              stepId: `${this.id}-step-${schedState.iteration}`,
              output: textAccumulator,
            },
          });

          // C3: configurable timeout (ADR 0032 default: 5000ms) — M3: clear timer on verdict arrival
          const verdictTimeout = verif.timeoutMs ?? 5_000;
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const verdictResult = await Promise.race([
            (async () => {
              for await (const env of verdictSub.events) {
                if (env.correlationId === verdictCorrId && env.kind === "verdict") {
                  // M3: verdict arrived — clear the timeout so the event loop drains
                  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
                  return env.verdict;
                }
              }
              return null;
            })(),
            new Promise<null>((resolve) => {
              timeoutHandle = setTimeout(() => resolve(null), verdictTimeout);
            }),
          ]);
          verdictSub.close();

          if (verdictResult) {
            const verdictKind = (verdictResult as { kind?: string }).kind ?? "unknown";
            // C3: ADR 0032 — inject for off_track, failed, AND partial (M9)
            if (
              verdictKind === "off-track" ||
              verdictKind === "failed" ||
              verdictKind === "partial"
            ) {
              // C3: ADR 0032 message format: "[Verification: ${kind}] ${rationale_or_suggestion}"
              const rationale =
                (verdictResult as { suggestion?: string; reason?: string; rationale?: string })
                  .suggestion ??
                (verdictResult as { suggestion?: string; reason?: string; rationale?: string })
                  .reason ??
                (verdictResult as { suggestion?: string; reason?: string; rationale?: string })
                  .rationale ??
                "Reconsider your approach.";
              messages.push({
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `[Verification: ${verdictKind}] ${rationale}`,
                  },
                ],
              });
              console.log(
                `[agent-runner:${this.id}] verification verdict=${verdictKind} — injecting correction`,
              );
            }
          }
        }
      }
      // --- end per-step verification ---

      // Check termination predicate
      if (spec.termination.done.kind === "tool_emitted") {
        const targetTool = spec.termination.done.tool;
        if (pendingToolCalls.size > 0) {
          for (const tc of pendingToolCalls.values()) {
            if (tc.name === targetTool) {
              this.setState("completed");
              await bus.send({
                kind: "result",
                correlationId,
                sessionId,
                from: this.id,
                to: { kind: "broadcast" },
                timestamp: Date.now(),
                payload: { reason: "tool_emitted", tool: targetTool },
              });
              this.closeInbox();
              midRunQuotaDenySub.close();
              return;
            }
          }
        }
      }

      // If no tool calls and stop reason is end_turn, we're done
      if (pendingToolCalls.size === 0 && stopReason === "end_turn") {
        this.setState("completed");
        await bus.send({
          kind: "result",
          correlationId,
          sessionId,
          from: this.id,
          to: { kind: "broadcast" },
          timestamp: Date.now(),
          payload: { text: textAccumulator, reason: "end_turn" },
        });
        this.closeInbox();
        midRunQuotaDenySub.close();
        return;
      }

      // Execute tool calls
      if (pendingToolCalls.size > 0) {
        this.setState("calling_tool");
        const toolResultContents: ProviderContent[] = [];

        for (const [toolCallId, tc] of pendingToolCalls) {
          // G: emit progress per tool call
          await bus.send({
            kind: "progress",
            correlationId,
            sessionId,
            from: this.id,
            to: { kind: "broadcast" },
            timestamp: Date.now(),
            currentTool: tc.name,
            step: `tool:${tc.name}`,
          });

          // Use corrected input from the pre-computation map (built before the
          // assistant message was appended). This ensures the input dispatched to
          // the tool, echoed back in the assistant message, and fingerprinted by
          // the cycle guard are all the same corrected value. See M3c2 finding #4.
          const correctedInput = correctedInputs.get(toolCallId) ?? {};

          const tool = this.deps.toolRegistry.get(tc.name);
          if (!tool) {
            toolResultContents.push({
              type: "tool_result",
              toolCallId,
              output: { error: `Tool ${tc.name} not found` },
              isError: true,
            });
            continue;
          }

          // C4: Enforce PermissionDescriptor.defaultMode BEFORE sandbox.run.
          // "deny" → refuse immediately; "ask" → emit human.request and await reply/timeout.
          // "auto" → pass through to sandbox authorization below.
          const permDefaultMode = tool.spec.permission.defaultMode;
          if (permDefaultMode === "deny") {
            toolResultContents.push({
              type: "tool_result",
              toolCallId,
              output: { error: `Permission denied for tool ${tc.name} (defaultMode: deny)` },
              isError: true,
            });
            continue;
          }

          // Session-mode override: in autonomous modes, skip the human ask path.
          // Tools with defaultMode="deny" are still hard-denied above; only "ask" is
          // affected. This matches Claude Code / Codex behavior where mode "auto" means
          // autonomous tool use without per-call human confirmation.
          const sessMode = this.deps.sessionMode ?? "auto";
          const autonomousMode = sessMode === "auto" || sessMode === "bypass";

          if (permDefaultMode === "ask" && !autonomousMode) {
            // Emit a human.request and block until human.reply or human.timeout (60s default)
            await bus.send({
              kind: "human.request",
              correlationId,
              sessionId,
              from: this.id,
              to: { kind: "broadcast" },
              timestamp: Date.now(),
              prompt: `Allow tool "${tc.name}"? ${tool.spec.permission.rationale}`,
            });

            const askTimeout = 60_000;
            let askTimerHandle: ReturnType<typeof setTimeout> | undefined;
            const humanSub = bus.subscribe(this.id, { kind: "self" });

            const askOutcome = await Promise.race([
              (async (): Promise<"allow" | "deny"> => {
                for await (const env of humanSub.events) {
                  if (schedState.abortController.signal.aborted) return "deny";
                  if (env.correlationId !== correlationId) continue;
                  if (env.kind === "human.reply") {
                    if (askTimerHandle !== undefined) clearTimeout(askTimerHandle);
                    const reply = env.reply;
                    // Truthy string values ("yes", "allow", "true", "1") → allow
                    const affirmative =
                      typeof reply === "boolean"
                        ? reply
                        : typeof reply === "string"
                          ? /^(yes|allow|true|1)$/i.test(reply.trim())
                          : Boolean(reply);
                    return affirmative ? "allow" : "deny";
                  }
                  if (env.kind === "human.timeout") {
                    if (askTimerHandle !== undefined) clearTimeout(askTimerHandle);
                    return "deny";
                  }
                }
                return "deny";
              })(),
              new Promise<"deny">((resolve) => {
                askTimerHandle = setTimeout(() => resolve("deny"), askTimeout);
              }),
            ]);
            humanSub.close();

            if (askOutcome === "deny") {
              toolResultContents.push({
                type: "tool_result",
                toolCallId,
                output: {
                  error: `Permission denied for tool ${tc.name} (human denied or timeout)`,
                },
                isError: true,
              });
              continue;
            }
            // askOutcome === "allow" → fall through to sandbox authorization
          }

          // Sandbox authorization (sandbox-level effects check)
          const effects = tool.spec.permission.effects;
          let authorized = true;
          for (const effect of effects) {
            const sandboxReq: SandboxRequest = { effect, target: tc.name };
            const authResult = await this.deps.sandbox.authorize(sandboxReq);
            if (!authResult.ok || authResult.value.kind === "deny") {
              authorized = false;
              break;
            }
          }

          if (!authorized) {
            toolResultContents.push({
              type: "tool_result",
              toolCallId,
              output: { error: `Permission denied for tool ${tc.name}` },
              isError: true,
            });
            continue;
          }

          // ADR 0034: correction was pre-applied in the correctedInputs map above.
          // Build the final invocation using the corrected input so that the tool,
          // the recorder, and the cycle-guard all see the same (corrected) value.
          const invocation: ToolInvocation = {
            toolCallId: toolCallId as never,
            callerAgent: this.id,
            name: tc.name,
            input: correctedInput,
            signal: schedState.abortController.signal,
          };

          const toolStart = Date.now();
          const toolResult = await this.deps.sandbox.run(
            { effect: effects[0] ?? "state_read", target: tc.name },
            async () => tool.invoke(invocation),
          );

          const toolEnd = Date.now();

          let result: ToolResult;
          if (toolResult.ok && toolResult.value.ok) {
            // M3b: apply truncation notice before projections run — if sizeBytes > preview.length
            result = maybeApplyTruncationNotice(toolResult.value.value);
          } else {
            result = {
              ok: false,
              preview: toolResult.ok
                ? String((toolResult.value as { error?: unknown }).error)
                : toolResult.error.message,
            };
          }

          if (this.deps.recorder) {
            this.deps.recorder.record({
              kind: "tool_call",
              at: toolStart,
              call: invocation,
              result,
            });
          }

          // C3: record tool cost if reported in meta
          if (this.deps.costMeter && result.meta) {
            // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
            const toolUsd = result.meta["usd"];
            if (typeof toolUsd === "number" && toolUsd > 0) {
              this.deps.costMeter.record({
                agent: this.id,
                ...(this.deps.contractId !== undefined ? { contract: this.deps.contractId } : {}),
                category: "tool",
                usd: toolUsd,
              });
            }
          }

          completedToolCalls.push({ toolCallId, name: tc.name, input: correctedInput, result });

          // C5: Apply projections if declared
          let preview = result.preview;
          const projectionsApplied: string[] = [];
          let projectionsSkipped: string[] | undefined;
          let artifactHandle: string | undefined;

          if (spec.projections) {
            for (const proj of spec.projections) {
              if (proj.tool === tc.name || proj.tool === "*") {
                for (const step of proj.steps) {
                  if (step.kind === "cap") {
                    if (preview.length > step.maxBytes) {
                      preview =
                        preview.slice(0, step.maxBytes) +
                        (step.truncationMessage ?? "...[truncated]");
                    }
                    projectionsApplied.push("cap");
                  } else if (step.kind === "redact") {
                    // C5: redact — regex replace pattern with replacement
                    const re = new RegExp(step.pattern, "g");
                    preview = preview.replace(re, step.replacement);
                    projectionsApplied.push("redact");
                  } else if (step.kind === "to_handle") {
                    // C5: externalize full preview as artifact if over threshold
                    if (preview.length > step.overBytes) {
                      const handle =
                        `artifact-${this.id}-${++this.artifactCounter}` as ArtifactHandle;
                      this.artifactStore.set(handle, preview);
                      artifactHandle = handle;
                      preview = preview.slice(0, step.overBytes);
                      projectionsApplied.push("to_handle");
                    }
                  } else if (step.kind === "summarize" || step.kind === "project") {
                    // C5: warn once per session per kind, then skip
                    if (!warnedProjections.has(step.kind)) {
                      warnedProjections.add(step.kind);
                      console.warn(
                        `[emerge] projection step '${step.kind}' is not implemented in M1; skipping`,
                      );
                    }
                    projectionsSkipped = projectionsSkipped ?? [];
                    projectionsSkipped.push(step.kind);
                  }
                }
              }
            }
          }

          // Build projected result with meta
          const projectedResult: ToolResult = {
            ...result,
            preview,
            ...(artifactHandle !== undefined ? { handle: artifactHandle } : {}),
            meta: {
              ...result.meta,
              ...(projectionsApplied.length > 0 ? { projectionsApplied } : {}),
              ...(projectionsSkipped !== undefined ? { projectionsSkipped } : {}),
            },
          };

          toolResultContents.push({
            type: "tool_result",
            toolCallId,
            output: preview,
          });

          // Use invocation.input (the corrected value) for cycle-guard fingerprinting
          // so that two corrections of the same raw output yield the same fingerprint.
          // See M3c2 review finding #4.
          schedState.cycleGuard.recordToolCall(
            this.id,
            tc.name,
            JSON.stringify(invocation.input),
            projectedResult.preview.slice(0, 64),
          );

          scheduler.recordUsage(schedState, {
            tokensIn: 0,
            tokensOut: 0,
            wallMs: toolEnd - toolStart,
            toolCalls: 1,
            usd: 0,
          });
        }

        // Append tool results as user message
        messages.push({ role: "user", content: toolResultContents });

        // Append to memory
        for (const tr of completedToolCalls) {
          await this.deps.memory.append([
            {
              tier: "episodic",
              content: `tool:${tr.name} → ${tr.result.preview.slice(0, 200)}`,
              attributes: { tool: tr.name, agent: this.id },
            },
          ]);
        }

        // Check tool-emitted termination predicate
        if (spec.termination.done.kind === "tool_emitted") {
          const targetTool = spec.termination.done.tool;
          for (const tr of completedToolCalls) {
            if (tr.name === targetTool) {
              this.setState("completed");
              await bus.send({
                kind: "result",
                correlationId,
                sessionId,
                from: this.id,
                to: { kind: "broadcast" },
                timestamp: Date.now(),
                payload: { reason: "tool_emitted", tool: targetTool },
              });
              this.closeInbox();
              midRunQuotaDenySub.close();
              return;
            }
          }
        }
      }
    }
    // C1/C2: close subscriptions on normal loop exit
    this.closeInbox();
    midRunQuotaDenySub.close();
  }

  private setState(s: AgentState): void {
    this._state = s;
    this.deps.scheduler.setState(this.id, s);
    this._lastActivityAt = Date.now();
  }
}
