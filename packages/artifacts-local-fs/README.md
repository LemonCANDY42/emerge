# @lwrf42/emerge-artifacts-local-fs

Local-filesystem artifact store for the emerge agent harness.

Provides an `ArtifactStore` implementation backed by the local filesystem. Agents write artifacts (files, logs, structured outputs) to named paths under a configurable root directory.

v0.1.0 — early. See main repo for verified-vs-unverified surfaces.

## Install

```bash
npm install @lwrf42/emerge-artifacts-local-fs
```

## Quick example

```ts
import { LocalFsArtifactStore } from "@lwrf42/emerge-artifacts-local-fs";

const store = new LocalFsArtifactStore({
  root: "/tmp/emerge/artifacts",
});

// Used internally by the kernel and agent tools; or programmatically:
await store.put("report.md", Buffer.from("# Report\n..."));
const data = await store.get("report.md");
```

## Artifact lifecycle

Artifacts are keyed by agent ID and session ID so concurrent sessions do not collide. The store creates directories on demand and does not require pre-initialization.

## Documentation

Full docs: https://github.com/LemonCANDY42/emerge
