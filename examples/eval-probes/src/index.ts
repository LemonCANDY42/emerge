/**
 * eval-probes — demonstrate real runProbesAsync() with MockProvider.
 *
 * Run 1: A "weak" mock that returns ambiguous/empty responses → ceiling = trivial.
 * Run 2: A "strong" mock that returns meaningful responses for all probes → ceiling = research.
 */

import type { ProviderEvent } from "@lwrf42/emerge-kernel/contracts";
import { MockProvider } from "@lwrf42/emerge-provider-mock";
import { CalibratedSurveillance, DEFAULT_PROBES } from "@lwrf42/emerge-surveillance";

// --- Weak mock: returns generic "I don't know" for every call ---

const WEAK_RESPONSE: readonly ProviderEvent[] = [
  { type: "text_delta", text: "I'm not sure about that." },
  {
    type: "stop",
    reason: "end_turn",
    usage: { tokensIn: 10, tokensOut: 5, wallMs: 1, toolCalls: 0, usd: 0 },
  },
];

// --- Strong mock: returns targeted responses per probe goal ---

function strongResponseFor(goal: string): readonly ProviderEvent[] {
  let text = "Here is a comprehensive answer.";

  if (/hello/i.test(goal)) {
    text = "hello";
  } else if (/2\s*\+\s*2/i.test(goal)) {
    text = "4";
  } else if (/capital of france/i.test(goal)) {
    text = "Paris";
  } else if (/sort.*numbers/i.test(goal)) {
    text = "1, 2, 5, 8";
  } else if (/http/i.test(goal)) {
    text = "HTTP stands for HyperText Transfer Protocol.";
  } else if (/fahrenheit/i.test(goal)) {
    text = "37";
  } else if (/summarize/i.test(goal)) {
    text = "A fox jumped over a dog.";
  } else if (/git rebase/i.test(goal)) {
    text = "Use git rebase -i HEAD~3 to squash 3 commits interactively.";
  } else if (/regex.*email/i.test(goal)) {
    text = "[a-z]+@[a-z]+\\.[a-z]+";
  } else if (/rest api/i.test(goal)) {
    text =
      "1. Design endpoints\n2. Set up auth\n3. Implement handlers\n4. Add middleware\n5. Deploy";
  } else if (/cache/i.test(goal)) {
    text = "- L1 cache in-process\n- L2 cache distributed\n- Eviction via LRU";
  } else if (/monolith.*microservice/i.test(goal)) {
    text =
      "1. Monolith is simpler; microservices scale better.\n2. Deployment differs.\n3. Communication overhead.";
  } else if (/distributed consensus/i.test(goal)) {
    text = "Raft, Paxos, and PBFT are common. I recommend Raft for its simplicity.";
  } else if (/gpt.*bert/i.test(goal) || /bert.*gpt/i.test(goal)) {
    text = "GPT is autoregressive; BERT is bidirectional. GPT generates; BERT understands.";
  } else if (/cap theorem/i.test(goal)) {
    text = "CAP: Consistency, Availability, Partition tolerance. MongoDB favors CP; Cassandra AP.";
  }

  return [
    { type: "text_delta", text },
    {
      type: "stop",
      reason: "end_turn",
      usage: { tokensIn: 20, tokensOut: text.length, wallMs: 1, toolCalls: 0, usd: 0 },
    },
  ];
}

// Build a strong script covering all probes in order
const strongScript = DEFAULT_PROBES.map((probe) => ({
  events: strongResponseFor(probe.goal),
}));

async function runProbeDemo(
  label: string,
  script: ReadonlyArray<{ events: readonly ProviderEvent[] }>,
): Promise<void> {
  console.log(`\n=== ${label} ===`);

  const provider = new MockProvider(script, {
    id: `mock-${label.toLowerCase().replace(/\s+/g, "-")}`,
  });
  const surveillance = new CalibratedSurveillance({ maxDepth: 4 });

  const result = await surveillance.runProbesAsync(provider);
  if (!result.ok) {
    console.error("Probe run failed:", result.error.message);
    process.exit(1);
  }

  const { ceiling, perDifficulty, envelope } = result.value;

  console.log(`  Probe ceiling: ${ceiling}`);
  console.log(
    `  Overall probe success rate: ${((envelope.probeSuccessRate ?? 0) * 100).toFixed(1)}%`,
  );
  console.log("  Per-difficulty pass rates:");
  for (const [diff, stats] of Object.entries(perDifficulty)) {
    if (!stats) continue;
    const pct = ((stats.passed / stats.total) * 100).toFixed(0);
    console.log(`    ${diff.padEnd(10)}: ${stats.passed}/${stats.total} (${pct}%)`);
  }

  // Compare claimed vs observed
  const claimed = provider.capabilities.claimed;
  console.log(`  Claimed context window: ${claimed.contextWindow.toLocaleString()} tokens`);
  console.log(`  Observed ceiling: ${ceiling} (probe-derived, not heuristic)`);
}

async function main(): Promise<void> {
  console.log("emerge eval-probes — demonstrates real runProbesAsync()");

  // Run 1: Weak mock
  await runProbeDemo(
    "Weak Mock (ambiguous responses)",
    DEFAULT_PROBES.map(() => ({ events: WEAK_RESPONSE as ProviderEvent[] })),
  );

  // Run 2: Strong mock
  await runProbeDemo("Strong Mock (targeted responses)", strongScript);

  console.log("\nDone. Exits 0.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
