# @lwrf42/emerge-experience-inmemory

In-memory `ExperienceLibrary` backend with postmortem analysis and surveillance hints for the emerge harness.

Stores `Experience` records keyed by problem-solving approach (not topic). Surveillance reads them as priors at session start. Bundles are exportable, importable, and mergeable.

v0.1.0 — early. Custodian + Adjudicator + Postmortem auto-loop verified end-to-end — see VERIFICATION.md.

## Install

```bash
npm install @lwrf42/emerge-experience-inmemory
```

## Quick example

```ts
import { InMemoryExperienceLibrary } from "@lwrf42/emerge-experience-inmemory";
import { SurveillanceModule } from "@lwrf42/emerge-surveillance";

const library = new InMemoryExperienceLibrary();

const surveillance = new SurveillanceModule({
  experienceLibrary: library,
  // ... other options
});

const kernel = new Kernel({ surveillance, provider, telemetry });
// After each session, kernel.mountPostmortem() distills an Experience
// into the library. Next session starts with those hints as priors.
```

## Export / import

```ts
const bundle = await library.exportBundle();
await fs.writeFile("experiences.json", JSON.stringify(bundle));

// Share with team or import into another instance:
const library2 = new InMemoryExperienceLibrary();
await library2.importBundle(bundle);
```

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
