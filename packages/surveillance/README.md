# @lwrf42/emerge-surveillance

Model capability surveillance and adaptive decomposition for the emerge agent harness.

Continuously probes the active model's competence on the current task. When the gap is too wide, it automatically re-plans with finer decomposition or escalates to a stronger model. Reads experience hints from past sessions as priors at session start.

v0.1.0 — early. Surveillance hint loop verified end-to-end — see VERIFICATION.md.

## Install

```bash
npm install @lwrf42/emerge-surveillance
```

## Quick example

```ts
import { SurveillanceModule } from "@lwrf42/emerge-surveillance";

const surveillance = new SurveillanceModule({
  probeInterval: 3,          // probe every N turns
  decompositionThreshold: 0.4, // re-plan below this competence score
  experienceLibrary,         // optional: @lwrf42/emerge-experience-inmemory
});

const kernel = new Kernel({ surveillance, provider, telemetry });
// Surveillance runs automatically; competence scores emitted to telemetry.
```

## What it does

1. After each agent turn, scores the model's response against task difficulty
2. If score drops below threshold, triggers adaptive re-decomposition
3. At session start, loads experience hints from past similar tasks (if library provided)
4. Emits competence verdicts to telemetry for dashboarding

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
