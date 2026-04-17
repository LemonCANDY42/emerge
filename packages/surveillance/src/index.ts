/**
 * @emerge/surveillance — CalibratedSurveillance implementation.
 *
 * Assesses model competence before each step and updates rolling
 * per-(providerId, difficulty) statistics after each step.
 */

import type {
  AssessmentInput,
  ExperienceLibrary,
  ObservedCapabilities,
  ProviderCapabilities,
  ProviderId,
  Recommendation,
  StepObservation,
  StepProfile,
  Surveillance,
  ToolName,
} from "@emerge/kernel/contracts";
import type { ExperienceAware } from "@emerge/kernel/contracts";

// Re-export the probe type (not in contracts, so we define it here)
export interface Probe {
  readonly id: string;
  readonly difficulty: StepProfile["difficulty"];
  readonly goal: string;
  readonly tools: readonly ToolName[];
  readonly expectedAnswer?: unknown;
}

// Default probe set covering each difficulty class
export const DEFAULT_PROBES: readonly Probe[] = [
  {
    id: "probe-trivial-echo",
    difficulty: "trivial",
    goal: "Repeat the word 'hello'.",
    tools: [],
    expectedAnswer: "hello",
  },
  {
    id: "probe-small-sum",
    difficulty: "small",
    goal: "What is 2 + 2?",
    tools: [],
    expectedAnswer: "4",
  },
  {
    id: "probe-medium-summarize",
    difficulty: "medium",
    goal: "Summarize the following in one sentence: 'The quick brown fox jumps over the lazy dog.'",
    tools: [],
  },
  {
    id: "probe-large-plan",
    difficulty: "large",
    goal: "Outline a 5-step plan to build a REST API with authentication.",
    tools: [],
  },
  {
    id: "probe-research-synthesis",
    difficulty: "research",
    goal: "Compare three approaches to distributed consensus and recommend one.",
    tools: [],
  },
];

// Rolling window entry for per-(provider, difficulty) stats
interface StatsBucket {
  total: number;
  failures: number;
  retries: number;
  toolErrors: number;
  costOvershoots: number; // overshoot >= 1.5 counts
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
}

export class CalibratedSurveillance implements Surveillance, ExperienceAware {
  private readonly maxDepth: number;
  private readonly failureRateThreshold: number;
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
    const failureRate = bucket.total > 0 ? bucket.failures / bucket.total : 0;
    const cycleHitsBucket = this.getCycleHitsBucket(providerId);
    const hasCycleHits = cycleHitsBucket > 0;
    const costOvershootRate = bucket.total > 0 ? bucket.costOvershoots / bucket.total : 0;

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

    // Cost-overshoot (>= 1.5 ratio) biases toward decompose
    const costBiasesDecompose = costOvershootRate > 0.3;

    // Determine model's effective competence ceiling from probes or observed
    const probeCeiling = this.probeHighWater.get(providerId);
    const observedCeiling = this.resolveCompetenceCeiling(capabilities);
    // Use probe result if available; fall back to observed / claimed
    const competenceCeiling = probeCeiling ?? observedCeiling;

    const stepRank = difficultyRank(step.difficulty);
    const ceilingRank = difficultyRank(competenceCeiling);

    // Experience hints can adjust confidence
    const experienceBoost = this.scoreExperienceHints(input);

    // The step is within the model's envelope
    if (stepRank <= ceilingRank) {
      // Repeated failures at this difficulty class suggest decompose
      if (failureRate >= this.failureRateThreshold && bucket.total >= 3) {
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
      if (failureRate >= this.failureRateThreshold && bucket.total >= 2) {
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
      bucket = { total: 0, failures: 0, retries: 0, toolErrors: 0, costOvershoots: 0 };
      this.stats.set(key, bucket);
    }

    bucket.total++;
    if (!obs.success) bucket.failures++;
    if (obs.retries > 0) bucket.retries++;
    if (obs.toolErrors > 0) bucket.toolErrors++;
    if (obs.costOvershoot !== undefined && obs.costOvershoot >= 1.5) bucket.costOvershoots++;

    // Update cycleHits tracking
    if (obs.cycleHits !== undefined && obs.cycleHits > 0) {
      this.cycleHitsCounter.set(
        providerId,
        (this.cycleHitsCounter.get(providerId) ?? 0) + obs.cycleHits,
      );
    }

    // Update ObservedCapabilities
    const toolErrorRate = bucket.total > 0 ? bucket.toolErrors / bucket.total : 0;
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
   * Run the calibrated probe set against a provider to determine its
   * competence ceiling. In M2 this is heuristic: we use the claimed
   * capabilities to infer the ceiling without actually making model calls,
   * since probe execution requires async model invocation which is outside
   * the Surveillance contract's scope.
   *
   * Real calibration happens via observe() as steps run. This method sets
   * the initial probe high-water mark based on claimed capabilities.
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
      b = { total: 0, failures: 0, retries: 0, toolErrors: 0, costOvershoots: 0 };
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
