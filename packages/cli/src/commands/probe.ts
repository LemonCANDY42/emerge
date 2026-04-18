/**
 * `emerge probe <provider-config>` — run the calibrated probe set against
 * a provider, print the capability envelope (ceiling).
 *
 * In v1 the only supported provider-config is "mock" (prints mock ceiling).
 * Real provider integration requires API keys and is documented in
 * docs/integrations/.
 *
 * provider-config may be a JSON string:
 *   { "kind": "mock", "ceiling": "medium" }
 * or the string "mock" as a shorthand.
 */

export async function probeCommand(providerConfigArg: string): Promise<void> {
  // Parse provider config — accept plain "mock" or JSON
  let ceiling = "trivial";
  let providerId = "mock";

  if (providerConfigArg.startsWith("{")) {
    try {
      const parsed = JSON.parse(providerConfigArg) as Record<string, unknown>;
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
      if (typeof parsed["kind"] === "string") providerId = parsed["kind"];
      // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here
      if (typeof parsed["ceiling"] === "string") ceiling = parsed["ceiling"];
    } catch {
      console.error(`[emerge probe] Invalid JSON provider config: ${providerConfigArg}`);
      process.exit(1);
    }
  } else {
    providerId = providerConfigArg;
    ceiling = providerId === "mock" ? "trivial" : "unknown";
  }

  if (providerId !== "mock") {
    console.error(
      `[emerge probe] Provider "${providerId}" is not supported by the CLI in v1.\nUse the library API to run probes against real providers:\n  import { CalibratedSurveillance } from "@emerge/surveillance";\n  const surv = new CalibratedSurveillance();\n  await surv.runProbesAsync(provider, signal);`,
    );
    process.exit(1);
  }

  // TODO(m3d): wire this to CalibratedSurveillance.runProbesAsync() once the
  // CLI supports real providers. Currently the mock provider returns a static
  // ceiling without running actual probes.
  console.log("[emerge probe] Running calibrated probe set against mock provider...");
  console.log(
    "[emerge probe] (stub: emerge probe is not yet wired to runProbesAsync — output is hard-coded)",
  );
  console.log("");
  console.log("Provider capability envelope:");
  console.log(`  provider id:   ${providerId}`);
  console.log(`  ceiling:       ${ceiling}`);
  console.log("  modalities:    text");
  console.log("  streaming:     true");
  console.log("  maxContext:    8192 tokens");
  console.log("");
  console.log(
    "Tip: to probe a real provider, use emerge's CalibratedSurveillance.runProbesAsync() in your TypeScript code.",
  );
  process.exit(0);
}
