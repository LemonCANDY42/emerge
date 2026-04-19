/**
 * LocalFsArtifactStore — file-backed ArtifactStore implementation.
 *
 * Each artifact is persisted as two files:
 *   {handle}.bin  — raw bytes
 *   {handle}.json — ArtifactMeta + current state + timestamps
 *
 * Writes are atomic: temp file + fs.rename.
 *
 * NOTE: gcExpired() must be called explicitly; it is NOT auto-run.
 * Schedule it externally (e.g. on session end or via a cron).
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type {
  AgentId,
  Artifact,
  ArtifactFilter,
  ArtifactHandle,
  ArtifactInput,
  ArtifactMeta,
  ArtifactState,
  ArtifactStore,
  Result,
} from "@lwrf42/emerge-kernel/contracts";

interface PersistedRecord {
  readonly handle: ArtifactHandle;
  readonly state: ArtifactState;
  readonly meta: ArtifactMeta;
  /** Epoch ms of the last state-transition write. */
  readonly stateChangedAt: number;
}

function artifactHandleId(): ArtifactHandle {
  // Use UUID v4 prefixed for human-recognisability
  return `art-${randomUUID()}` as ArtifactHandle;
}

function jsonPath(rootDir: string, handle: ArtifactHandle): string {
  return path.join(rootDir, `${handle}.json`);
}

function binPath(rootDir: string, handle: ArtifactHandle): string {
  return path.join(rootDir, `${handle}.bin`);
}

async function atomicWriteFile(filePath: string, data: Buffer | string): Promise<void> {
  // Mn6: use randomUUID() instead of Date.now() hash to avoid tmp filename collisions
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await fsPromises.writeFile(tmp, data);
  await fsPromises.rename(tmp, filePath);
}

export class LocalFsArtifactStore implements ArtifactStore {
  readonly rootDir: string;

  constructor(opts: { rootDir?: string } = {}) {
    this.rootDir = opts.rootDir ?? "./.emerge/artifacts";
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  async put(input: ArtifactInput): Promise<Result<{ readonly handle: ArtifactHandle }>> {
    const handle = artifactHandleId();
    const meta: ArtifactMeta = {
      size: input.bytes.length,
      mediaType: input.meta.mediaType,
      ownerAgent: input.meta.ownerAgent,
      ...(input.meta.pinnedBy !== undefined ? { pinnedBy: input.meta.pinnedBy } : {}),
      lifecycle: {
        createdAt: Date.now(),
        ...(input.meta.archiveAfterMs !== undefined
          ? { archiveAfterMs: input.meta.archiveAfterMs }
          : {}),
        ...(input.meta.expireAfterMs !== undefined
          ? { expireAfterMs: input.meta.expireAfterMs }
          : {}),
      },
      tags: input.meta.tags,
    };

    const record: PersistedRecord = {
      handle,
      state: "active",
      meta,
      stateChangedAt: Date.now(),
    };

    try {
      await atomicWriteFile(binPath(this.rootDir, handle), Buffer.from(input.bytes));
      await atomicWriteFile(jsonPath(this.rootDir, handle), JSON.stringify(record, null, 2));
      return { ok: true, value: { handle } };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "E_ARTIFACT_WRITE",
          message: `Failed to write artifact ${handle}: ${String(err)}`,
          cause: err,
        },
      };
    }
  }

  async get(handle: ArtifactHandle): Promise<Result<Artifact>> {
    try {
      const raw = await fsPromises.readFile(jsonPath(this.rootDir, handle), "utf-8");
      const record = JSON.parse(raw) as PersistedRecord;
      const artifact: Artifact = {
        handle: record.handle,
        state: record.state,
        meta: record.meta,
        bytes: async () => {
          const buf = await fsPromises.readFile(binPath(this.rootDir, handle));
          return new Uint8Array(buf);
        },
      };
      return { ok: true, value: artifact };
    } catch (err) {
      const code =
        err instanceof Error && "code" in err && err.code === "ENOENT"
          ? "E_ARTIFACT_NOT_FOUND"
          : "E_ARTIFACT_READ";
      return {
        ok: false,
        error: {
          code,
          message: `Artifact ${handle} not found or unreadable: ${String(err)}`,
          cause: err,
        },
      };
    }
  }

  async setState(handle: ArtifactHandle, state: ArtifactState): Promise<Result<void>> {
    const getResult = await this.get(handle);
    if (!getResult.ok) return getResult;
    const existing = getResult.value;

    const updated: PersistedRecord = {
      handle,
      state,
      meta: existing.meta,
      stateChangedAt: Date.now(),
    };

    try {
      await atomicWriteFile(jsonPath(this.rootDir, handle), JSON.stringify(updated, null, 2));
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "E_ARTIFACT_WRITE",
          message: `Failed to update state for artifact ${handle}: ${String(err)}`,
          cause: err,
        },
      };
    }
  }

  async list(filter?: ArtifactFilter): Promise<readonly Artifact[]> {
    let entries: string[];
    try {
      entries = await fsPromises.readdir(this.rootDir);
    } catch {
      return [];
    }

    const jsonFiles = entries.filter((e) => e.endsWith(".json"));
    const results: Artifact[] = [];

    for (const file of jsonFiles) {
      try {
        const raw = await fsPromises.readFile(path.join(this.rootDir, file), "utf-8");
        const record = JSON.parse(raw) as PersistedRecord;

        if (filter?.owner !== undefined && record.meta.ownerAgent !== filter.owner) continue;
        if (filter?.state !== undefined && record.state !== filter.state) continue;
        if (filter?.tag !== undefined && !record.meta.tags.includes(filter.tag)) continue;

        const handle = record.handle;
        results.push({
          handle,
          state: record.state,
          meta: record.meta,
          bytes: async () => {
            const buf = await fsPromises.readFile(binPath(this.rootDir, handle));
            return new Uint8Array(buf);
          },
        });
      } catch {
        // Skip corrupt or partial entries
      }
    }

    return results;
  }

  /**
   * Remove artifacts whose expireAfterMs has elapsed since createdAt.
   * Must be called explicitly — not auto-run.
   */
  async gcExpired(): Promise<{ removed: number }> {
    const all = await this.list();
    const now = Date.now();
    let removed = 0;

    for (const artifact of all) {
      const { expireAfterMs, createdAt } = artifact.meta.lifecycle;
      if (expireAfterMs !== undefined && now - createdAt >= expireAfterMs) {
        try {
          await fsPromises.unlink(jsonPath(this.rootDir, artifact.handle));
          await fsPromises.unlink(binPath(this.rootDir, artifact.handle)).catch(() => undefined);
          removed++;
        } catch {
          // Tolerate missing files during concurrent GC
        }
      }
    }

    return { removed };
  }
}

// Re-export types so consumers need only one import
export type {
  Artifact,
  ArtifactFilter,
  ArtifactHandle,
  ArtifactInput,
  ArtifactMeta,
  ArtifactState,
  ArtifactStore,
  AgentId,
};
