/**
 * @lwrf42/emerge-surveillance — CalibratedSurveillance implementation.
 *
 * Assesses model competence before each step and updates rolling
 * per-(providerId, difficulty) statistics after each step.
 */

import type {
  AssessmentInput,
  ExperienceLibrary,
  ObservedCapabilities,
  Provider,
  ProviderCapabilities,
  ProviderId,
  Recommendation,
  Result,
  StepObservation,
  StepProfile,
  Surveillance,
  ToolName,
} from "@lwrf42/emerge-kernel/contracts";
import type { ExperienceAware } from "@lwrf42/emerge-kernel/contracts";

// Re-export the probe type (not in contracts, so we define it here)
export interface Probe {
  readonly id: string;
  readonly difficulty: StepProfile["difficulty"];
  readonly goal: string;
  readonly tools: readonly ToolName[];
  /** Expected answer for scoring: string (contains check), RegExp, or callback. */
  readonly expectedAnswer?: string | RegExp | ((response: string) => boolean);
}

/**
 * Results of running the probe set against a provider.
 * ceiling = highest difficulty class where pass rate >= 70%.
 */
export interface ProbeResults {
  readonly ceiling: StepProfile["difficulty"];
  readonly perDifficulty: Partial<
    Record<StepProfile["difficulty"], { passed: number; total: number }>
  >;
  readonly envelope: ObservedCapabilities;
}

/** Default probe set: 3 probes per difficulty class (15 total). */
export const DEFAULT_PROBES: readonly Probe[] = [
  // trivial (3)
  {
    id: "probe-trivial-echo",
    difficulty: "trivial",
    goal: "Repeat the word 'hello'.",
    tools: [],
    expectedAnswer: /hello/i,
  },
  {
    id: "probe-trivial-sum",
    difficulty: "trivial",
    goal: "What is 2 + 2? Reply with just the number.",
    tools: [],
    expectedAnswer: /4/,
  },
  {
    id: "probe-trivial-capital",
    difficulty: "trivial",
    goal: "What is the capital of France? Reply with just the city name.",
    tools: [],
    expectedAnswer: /paris/i,
  },
  // small (3)
  {
    id: "probe-small-sort",
    difficulty: "small",
    goal: "Sort these numbers in ascending order: 5, 2, 8, 1. Reply with just the sorted list.",
    tools: [],
    expectedAnswer: /1.*2.*5.*8/,
  },
  {
    id: "probe-small-acronym",
    difficulty: "small",
    goal: "What does HTTP stand for? Reply in one sentence.",
    tools: [],
    expectedAnswer: /hypertext/i,
  },
  {
    id: "probe-small-convert",
    difficulty: "small",
    goal: "Convert 100 Fahrenheit to Celsius. Reply with just the number (rounded to nearest integer).",
    tools: [],
    expectedAnswer: /37|38/,
  },
  // medium (3)
  // M5: use specific patterns that the goal text doesn't already contain
  {
    id: "probe-medium-summarize",
    difficulty: "medium",
    goal: "Summarize the following in one sentence: 'The quick brown fox jumps over the lazy dog.'",
    tools: [],
    // A meaningful summary mentions the fox, the dog, or the jump — not just echoing the goal
    expectedAnswer: /\b(fox|dog|jump|leaps?|bounds?)\b/i,
  },
  {
    id: "probe-medium-rebase",
    difficulty: "medium",
    goal: "Explain how to use git rebase to squash 3 commits in 2 sentences.",
    tools: [],
    // M5: stricter — must mention HEAD~3 or interactive rebase (-i) to score pass
    expectedAnswer: /git rebase -i HEAD~3/i,
  },
  {
    id: "probe-medium-regex",
    difficulty: "medium",
    goal: "Write a regex that matches an email address. Reply with just the regex pattern.",
    tools: [],
    // M5: a valid email regex must have @ AND a dot somewhere after it
    expectedAnswer: /@.*\./,
  },
  // large (3)
  // M5: use specific patterns not already present in the goal text
  {
    id: "probe-large-plan",
    difficulty: "large",
    goal: "Outline a 5-step plan to build a REST API with authentication.",
    tools: [],
    // M5: must produce ≥5 distinct lines and mention JWT, OAuth, token, or key — not just "authentication"
    expectedAnswer: (r) =>
      r.split("\n").filter((l) => l.trim().length > 0).length >= 5 &&
      /\b(jwt|oauth|token|api.?key|bearer)\b/i.test(r),
  },
  {
    id: "probe-large-cache",
    difficulty: "large",
    goal: "Outline the design of a multi-tier cache with eviction policy in 3-5 bullet points.",
    tools: [],
    // M5: must mention a specific eviction strategy (LRU, LFU, TTL) not just repeat "evict"
    expectedAnswer: /\b(lru|lfu|ttl|least.recently.used|least.frequently.used|time.to.live)\b/i,
  },
  {
    id: "probe-large-tradeoffs",
    difficulty: "large",
    goal: "List 3 tradeoffs between monolithic and microservices architectures.",
    tools: [],
    // M5: must mention concrete tradeoff dimensions (deploy, scale, complexity, latency, network)
    expectedAnswer: /\b(deploy|scal|complexit|latency|network|coupling|independen)\b/i,
  },
  // research (3)
  // M5: use specific patterns not already present in the goal text
  {
    id: "probe-research-consensus",
    difficulty: "research",
    goal: "Compare three approaches to distributed consensus and recommend one.",
    tools: [],
    // M5: must name at least one real consensus algorithm
    expectedAnswer: /\b(paxos|raft|pbft|viewstamp|zab|multi.paxos)\b/i,
  },
  {
    id: "probe-research-llm",
    difficulty: "research",
    goal: "Summarize 3 key differences between GPT-style and BERT-style language models.",
    tools: [],
    // M5: must mention the architectural distinction (autoregressive/causal vs masked/bidirectional)
    expectedAnswer: /\b(autoregressive|causal|masked|bidirectional|encoder|decoder)\b/i,
  },
  {
    id: "probe-research-cap",
    difficulty: "research",
    goal: "Explain the CAP theorem and give one real-world database example for each combination.",
    tools: [],
    // M5: must name at least one real database (Cassandra, MongoDB, etc.)
    expectedAnswer:
      /\b(cassandra|mongodb|dynamodb|zookeeper|etcd|postgres|mysql|redis|hbase|couchdb)\b/i,
  },
];

// Sliding-window stats bucket — outcomes are capped at windowSize so early
// observations don't anchor the failure rate permanently (M1 fix).
const STATS_WINDOW_SIZE = 50;

interface StatsBucket {
  /** Circular buffer of recent outcomes; length <= STATS_WINDOW_SIZE. */
  outcomes: Array<"success" | "failure">;
  /** Whether each recent step had any retries. */
  hadRetry: boolean[];
  /** Whether each recent step had any tool errors. */
  hadToolError: boolean[];
  /** Whether each recent step was a cost-overshoot (ratio >= 1.5). */
  hadCostOvershoot: boolean[];
}

function difficultyRank(d: StepProfile["difficulty"]): number {
  switch (d) {
    case "trivial":
      return 0;
    case "small":
      return 1;
    case "medium":
      return 2;
    case "large":
      return 3;
    case "research":
      return 4;
  }
}

export interface CalibratedSurveillanceConfig {
  readonly maxDepth: number;
  readonly failureRateThreshold?: number; // default 0.25
  /** Pre-seeded envelope data (used in tests or when runProbes is skipped). */
  readonly envelope?: ReadonlyMap<string, ObservedCapabilities>;
  readonly experienceLibrary?: ExperienceLibrary;
  /**
   * When set, the model's probe ceiling is "trivial" AND the step difficulty is
   * "large" or "research", surveillance emits escalate delegating to this provider.
   */
  readonly escalateTo?: ProviderId;
  /**
   * When true, a sustained budget-overshoot rate (costOvershoot >= 1.5) near
   * the decomposition depth limit emits defer instead of decompose.
   */
  readonly deferOnBudgetOvershoot?: boolean;
  /**
   * When true, cost-overshoot ratio never triggers decomposition.
   *
   * The cost-overshoot decompose path is only meaningful when the heuristic
   * forecast is calibrated against a real provider's pricing. For scripted mock
   * providers (where USD values in events are arbitrary) the forecast heuristic
   * can produce near-zero predictions, leading to spurious 100x+ overshots that
   * trigger decomposition on every second step. Set this to true in tbench
   * sessions that use MockProvider or any provider where cost tracking is not
   * meaningful for decomposition decisions.
   */
  readonly disableCostOvershootDecompose?: boolean;
}

export class CalibratedSurveillance implements Surveillance, ExperienceAware {
  private readonly maxDepth: number;
  private readonly failureRateThreshold: number;
  private readonly escalateTo: ProviderId | undefined;
  private readonly deferOnBudgetOvershoot: boolean;
  private readonly disableCostOvershootDecompose: boolean;
  private experienceLibrary: ExperienceLibrary | undefined;

  // Rolling stats: key = `${providerId}::${difficulty}`
  private readonly stats = new Map<string, StatsBucket>();
  // Observed capabilities per provider (competence ceiling etc.)
  private readonly envelopeMap = new Map<ProviderId, ObservedCapabilities>();
  // Probe results per provider: highest difficulty that passed
  private readonly probeHighWater = new Map<ProviderId, StepProfile["difficulty"]>();

  constructor(config: CalibratedSurveillanceConfig) {
    this.maxDepth = config.maxDepth;
    this.failureRateThreshold = config.failureRateThreshold ?? 0.25;
    this.escalateTo = config.escalateTo;
    this.deferOnBudgetOvershoot = config.deferOnBudgetOvershoot ?? false;
    this.disableCostOvershootDecompose = config.disableCostOvershootDecompose ?? false;
    this.experienceLibrary = config.experienceLibrary;
    if (config.envelope) {
      for (const [k, v] of config.envelope) {
        this.envelopeMap.set(k as ProviderId, v);
      }
    }
  }

  setLibrary(lib: ExperienceLibrary): void {
    this.experienceLibrary = lib;
  }

  async assess(input: AssessmentInput): Promise<Recommendation> {
    const { providerId, step, decompositionDepth, capabilities } = input;

    // Bounded recursion guard — if already at max depth, just proceed
    if (decompositionDepth >= this.maxDepth) {
      return {
        kind: "proceed",
        confidence: 0.6,
        rationale: `decompositionDepth(${decompositionDepth}) >= maxDepth(${this.maxDepth}); proceeding to avoid infinite decomposition`,
      };
    }

    const bucket = this.getBucket(providerId, step.difficulty);
    const windowLen = bucket.outcomes.length;
    // Compute rates from the sliding window so early failures don't anchor stats.
    const failureRate =
      windowLen > 0 ? bucket.outcomes.filter((o) => o === "failure").length / windowLen : 0;
    const cycleHitsBucket = this.getCycleHitsBucket(providerId);
    const hasCycleHits = cycleHitsBucket > 0;
    const costOvershootRate =
      windowLen > 0 ? bucket.hadCostOvershoot.filter(Boolean).length / windowLen : 0;

    // Cycle-guard hits bias toward scaffold
    if (hasCycleHits) {
      return {
        kind: "scaffold",
        additions: [
          {
            kind: "system_note",
            content:
              "You appear to be repeating the same action. Review what you have already done and choose a different approach to make progress.",
          },
        ],
        rationale: `Cycle-guard hits detected for provider ${providerId}; injecting loop-break scaffold`,
      };
    }

    // Cost-overshoot (>= 1.5 ratio) biases toward decompose.
    // Disabled when disableCostOvershootDecompose=true (e.g. scripted mock providers
    // where the heuristic forecast is not calibrated against real pricing).
    const costBiasesDecompose = !this.disableCostOvershootDecompose && costOvershootRate > 0.3;

    // Determine model's effective competence ceiling from probes or observed
    const probeCeiling = this.probeHighWater.get(providerId);
    const observedCeiling = this.resolveCompetenceCeiling(capabilities);
    // Use probe result if available; fall back to observed / claimed
    const competenceCeiling = probeCeiling ?? observedCeiling;

    const stepRank = difficultyRank(step.difficulty);
    const ceilingRank = difficultyRank(competenceCeiling);

    // Escalate: probe ceiling is "trivial" AND step difficulty is "large" or "research"
    // AND an escalation target was configured — gap >= 2 levels above trivial.
    if (
      this.escalateTo !== undefined &&
      competenceCeiling === "trivial" &&
      (step.difficulty === "large" || step.difficulty === "research")
    ) {
      return {
        kind: "escalate",
        delegateTo: this.escalateTo,
        rationale: `step difficulty '${step.difficulty}' exceeds calibrated ceiling '${competenceCeiling}' by ≥2 levels; escalating to ${this.escalateTo}`,
      };
    }

    // Defer: budget-overshoot rate is sustained AND we are near the maximum
    // decomposition depth — cannot decompose further, needs human checkpoint.
    const overshootCount = bucket.hadCostOvershoot.filter(Boolean).length;
    if (
      this.deferOnBudgetOvershoot &&
      overshootCount >= 1 &&
      windowLen > 0 &&
      costOvershootRate >= 0.5 &&
      decompositionDepth >= this.maxDepth - 1
    ) {
      return {
        kind: "defer",
        checkpoint: "budget-near-exhaustion",
        rationale: `sustained cost-overshoot rate ${(costOvershootRate * 100).toFixed(0)}% at decomposition depth ${decompositionDepth}/${this.maxDepth}; cannot decompose further — needs human`,
      };
    }

    // Experience hints can adjust confidence
    const experienceBoost = this.scoreExperienceHints(input);

    // The step is within the model's envelope
    if (stepRank <= ceilingRank) {
      // Repeated failures at this difficulty class suggest decompose
      if (failureRate >= this.failureRateThreshold && windowLen >= 3) {
        return {
          kind: "decompose",
          subSteps: [],
          rationale: `failure rate ${(failureRate * 100).toFixed(0)}% at ${step.difficulty} difficulty exceeds threshold ${(this.failureRateThreshold * 100).toFixed(0)}%; decomposing step`,
        };
      }

      if (costBiasesDecompose) {
        return {
          kind: "decompose",
          subSteps: [],
          rationale: `cost-overshoot rate ${(costOvershootRate * 100).toFixed(0)}% biases toward decomposition`,
        };
      }

      const confidence = Math.min(0.95, 0.7 + experienceBoost - failureRate * 0.5);
      return {
        kind: "proceed",
        confidence,
        rationale: `step difficulty '${step.difficulty}' within model envelope (ceiling: '${competenceCeiling}'); failure rate ${(failureRate * 100).toFixed(0)}%`,
      };
    }

    // Step exceeds model envelope
    const gap = stepRank - ceilingRank;

    if (gap === 1) {
      // One level above ceiling — could still try, but biased toward decompose on repeated failures
      if (failureRate >= this.failureRateThreshold && windowLen >= 2) {
        return {
          kind: "decompose",
          subSteps: [],
          rationale: `step '${step.difficulty}' is one level above model ceiling '${competenceCeiling}' and failure rate ${(failureRate * 100).toFixed(0)}% is high`,
        };
      }
      // Give it a chance with low confidence
      if (experienceBoost > 0.2) {
        return {
          kind: "proceed",
          confidence: 0.4 + experienceBoost,
          rationale:
            "experience hints suggest this approach may work despite exceeding claimed envelope",
        };
      }
      return {
        kind: "decompose",
        subSteps: [],
        rationale: `step '${step.difficulty}' exceeds model envelope ceiling '${competenceCeiling}'; recommending decomposition`,
      };
    }

    // Two or more levels above ceiling — decompose
    return {
      kind: "decompose",
      subSteps: [],
      rationale: `step '${step.difficulty}' (rank=${stepRank}) is ${gap} levels above model envelope ceiling '${competenceCeiling}' (rank=${ceilingRank}); decomposing`,
    };
  }

  async observe(obs: StepObservation): Promise<void> {
    // We need the providerId — it's embedded in the stepId prefix by convention.
    // However, the contract doesn't pass providerId to observe(). We update the
    // general stats keyed by stepId pattern. In practice the kernel always calls
    // assess() first so we store the last-assessed providerId per agent.
    // For M2 we use the last-assessed context stored in a side-channel.
    const providerId = this.lastAssessedProvider.get(obs.agent);
    if (!providerId) return;

    const difficulty = this.lastAssessedDifficulty.get(obs.agent);
    if (!difficulty) return;

    const key = this.bucketKey(providerId, difficulty);
    let bucket = this.stats.get(key);
    if (!bucket) {
      bucket = { outcomes: [], hadRetry: [], hadToolError: [], hadCostOvershoot: [] };
      this.stats.set(key, bucket);
    }

    // Sliding window: evict oldest entry when window is full.
    if (bucket.outcomes.length >= STATS_WINDOW_SIZE) {
      bucket.outcomes.shift();
      bucket.hadRetry.shift();
      bucket.hadToolError.shift();
      bucket.hadCostOvershoot.shift();
    }
    bucket.outcomes.push(obs.success ? "success" : "failure");
    bucket.hadRetry.push(obs.retries > 0);
    bucket.hadToolError.push(obs.toolErrors > 0);
    bucket.hadCostOvershoot.push(obs.costOvershoot !== undefined && obs.costOvershoot >= 1.5);

    // Update cycleHits tracking. Decay by 1 on each successful step so a single
    // cycle hit does not poison the entire session (M2 fix).
    if (obs.cycleHits !== undefined && obs.cycleHits > 0) {
      this.cycleHitsCounter.set(
        providerId,
        (this.cycleHitsCounter.get(providerId) ?? 0) + obs.cycleHits,
      );
    } else if (obs.success) {
      const current = this.cycleHitsCounter.get(providerId) ?? 0;
      if (current > 0) {
        this.cycleHitsCounter.set(providerId, current - 1);
      }
    }

    // Update ObservedCapabilities using the current window.
    const wLen = bucket.outcomes.length;
    const toolErrorRate = wLen > 0 ? bucket.hadToolError.filter(Boolean).length / wLen : 0;
    const existing = this.envelopeMap.get(providerId) ?? {};
    this.envelopeMap.set(providerId, {
      ...existing,
      toolErrorRate,
      lastUpdatedAt: Date.now(),
    });
  }

  envelope(providerId: ProviderId): ProviderCapabilities["observed"] {
    return this.envelopeMap.get(providerId);
  }

  /**
   * Heuristic probe runner (synchronous, no model calls).
   * Used when you want to seed the envelope from claimed capabilities only —
   * e.g. in tests or when a real provider is not available.
   *
   * For real probe execution (M3b), call `runProbesAsync(provider, probes)`.
   */
  runProbes(provider: { capabilities: ProviderCapabilities }): void {
    const claimed = provider.capabilities.claimed;
    let ceiling: StepProfile["difficulty"] = "trivial";

    // Infer ceiling from claimed context window and quality signals
    if (claimed.contextWindow >= 100_000) {
      ceiling = "research";
    } else if (claimed.contextWindow >= 32_000) {
      ceiling = "large";
    } else if (claimed.contextWindow >= 8_000) {
      ceiling = "medium";
    } else if (claimed.contextWindow >= 2_000) {
      ceiling = "small";
    }

    this.probeHighWater.set(provider.capabilities.id, ceiling);
    this.envelopeMap.set(provider.capabilities.id, {
      probeSuccessRate: 0.9,
      lastUpdatedAt: Date.now(),
    });
  }

  /**
   * Run a real probe set against a provider.
   *
   * Each probe's `goal` is sent as a single-turn user message. The response is
   * scored against `expectedAnswer` (string contains, RegExp test, or callback).
   * Probes without an `expectedAnswer` are counted as passed when the response
   * is non-empty.
   *
   * ceiling = the highest difficulty class where pass rate >= 70%.
   * Updates the surveillance envelope with probe-derived data.
   *
   * M4: Accepts an optional AbortSignal to cancel running probes early.
   * M4: Accepts an optional `onProbeError` callback for error visibility (default: console.warn).
   * Note: probes run sequentially by default; concurrency > 1 may hit provider rate limits.
   */
  async runProbesAsync(
    provider: Provider,
    probes: readonly Probe[] = DEFAULT_PROBES,
    opts?: {
      /** M4: AbortSignal to cancel probe execution early. */
      signal?: AbortSignal;
      /**
       * M4: Called when a probe invocation throws. Default: console.warn.
       * Probe errors do not abort the run — the probe is counted as failed.
       */
      onProbeError?: (probe: Probe, error: unknown) => void;
      /**
       * Concurrency limit for probe execution. Default: 1 (sequential).
       * WARNING: values > 1 may hit provider rate limits.
       */
      concurrency?: number;
    },
  ): Promise<Result<ProbeResults>> {
    const providerId = provider.capabilities.id;
    const signal = opts?.signal;
    const onProbeError =
      opts?.onProbeError ??
      ((probe, err) => {
        console.warn(`[surveillance] probe "${probe.id}" failed:`, err);
      });

    // Group probes by difficulty
    const byDifficulty = new Map<StepProfile["difficulty"], Probe[]>();
    for (const probe of probes) {
      let group = byDifficulty.get(probe.difficulty);
      if (!group) {
        group = [];
        byDifficulty.set(probe.difficulty, group);
      }
      group.push(probe);
    }

    const perDifficulty: Partial<
      Record<StepProfile["difficulty"], { passed: number; total: number }>
    > = {};
    let totalPassed = 0;
    let totalRun = 0;

    const difficulties: StepProfile["difficulty"][] = [
      "trivial",
      "small",
      "medium",
      "large",
      "research",
    ];

    for (const difficulty of difficulties) {
      // M4: abort early if signal is triggered
      if (signal?.aborted) break;

      const group = byDifficulty.get(difficulty);
      if (!group || group.length === 0) continue;

      let passed = 0;
      for (const probe of group) {
        // M4: abort early if signal is triggered
        if (signal?.aborted) break;

        try {
          let responseText = "";
          // M4: pass signal into provider.invoke so the underlying HTTP request is cancelled
          const invokeReq =
            signal !== undefined
              ? {
                  messages: [
                    {
                      role: "user" as const,
                      content: [{ type: "text" as const, text: probe.goal }],
                    },
                  ],
                  signal,
                }
              : {
                  messages: [
                    {
                      role: "user" as const,
                      content: [{ type: "text" as const, text: probe.goal }],
                    },
                  ],
                };
          const iter = provider.invoke(invokeReq);
          for await (const event of iter) {
            if (signal?.aborted) break;
            if (event.type === "text_delta") responseText += event.text;
            if (event.type === "stop" || event.type === "error") break;
          }

          const pass = this.scoreProbe(probe, responseText);
          if (pass) passed++;
        } catch (err) {
          // M4: call onProbeError instead of silently swallowing
          onProbeError(probe, err);
        }
      }

      perDifficulty[difficulty] = { passed, total: group.length };
      totalPassed += passed;
      totalRun += group.length;
    }

    // ceiling = highest difficulty where pass rate >= 70%
    let ceiling: StepProfile["difficulty"] = "trivial";
    for (const difficulty of difficulties) {
      const stats = perDifficulty[difficulty];
      if (!stats || stats.total === 0) continue;
      if (stats.passed / stats.total >= 0.7) {
        ceiling = difficulty;
      }
    }

    const probeSuccessRate = totalRun > 0 ? totalPassed / totalRun : 0;
    const envelope: ObservedCapabilities = {
      probeSuccessRate,
      lastUpdatedAt: Date.now(),
    };

    this.probeHighWater.set(providerId, ceiling);
    this.envelopeMap.set(providerId, envelope);

    return {
      ok: true,
      value: { ceiling, perDifficulty, envelope },
    };
  }

  private scoreProbe(probe: Probe, response: string): boolean {
    if (!probe.expectedAnswer) return response.trim().length > 0;
    if (typeof probe.expectedAnswer === "string") {
      return response.toLowerCase().includes(probe.expectedAnswer.toLowerCase());
    }
    if (probe.expectedAnswer instanceof RegExp) {
      return probe.expectedAnswer.test(response);
    }
    return probe.expectedAnswer(response);
  }

  // --- side-channel: kernel sets these before calling observe() ---
  // (The contract doesn't pass providerId/difficulty to observe(), so the
  //  kernel must call notifyAssessment() after assess() returns.)

  private readonly lastAssessedProvider = new Map<string, ProviderId>();
  private readonly lastAssessedDifficulty = new Map<string, StepProfile["difficulty"]>();
  private readonly cycleHitsCounter = new Map<ProviderId, number>();

  /**
   * Called by the kernel after assess() to stash context for the subsequent observe().
   */
  notifyAssessment(
    agentId: string,
    providerId: ProviderId,
    difficulty: StepProfile["difficulty"],
  ): void {
    this.lastAssessedProvider.set(agentId, providerId);
    this.lastAssessedDifficulty.set(agentId, difficulty);
  }

  // --- internals ---

  private bucketKey(providerId: ProviderId, difficulty: StepProfile["difficulty"]): string {
    return `${providerId}::${difficulty}`;
  }

  private getBucket(providerId: ProviderId, difficulty: StepProfile["difficulty"]): StatsBucket {
    const key = this.bucketKey(providerId, difficulty);
    let b = this.stats.get(key);
    if (!b) {
      b = { outcomes: [], hadRetry: [], hadToolError: [], hadCostOvershoot: [] };
      this.stats.set(key, b);
    }
    return b;
  }

  private getCycleHitsBucket(providerId: ProviderId): number {
    return this.cycleHitsCounter.get(providerId) ?? 0;
  }

  private resolveCompetenceCeiling(capabilities: ProviderCapabilities): StepProfile["difficulty"] {
    // Use observed probe success rate if available
    const observed = this.envelopeMap.get(capabilities.id);
    if (observed?.probeSuccessRate !== undefined && observed.probeSuccessRate < 0.5) {
      return "small";
    }

    // Fall back to claimed context window heuristic
    const cw = capabilities.claimed.contextWindow;
    if (cw >= 100_000) return "research";
    if (cw >= 32_000) return "large";
    if (cw >= 8_000) return "medium";
    if (cw >= 2_000) return "small";
    return "trivial";
  }

  private scoreExperienceHints(input: AssessmentInput): number {
    if (!input.experienceHints || input.experienceHints.length === 0) return 0;
    // Average score of hints weighted by semantic relevance
    let total = 0;
    for (const hint of input.experienceHints) {
      total += hint.score;
    }
    return Math.min(0.3, (total / input.experienceHints.length) * 0.3);
  }
}
