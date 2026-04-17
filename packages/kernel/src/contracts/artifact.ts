/**
 * Artifact lifecycle — externalize phase outputs as addressable values.
 *
 * The Custodian routes artifacts; the kernel exposes a thin facade so any
 * module can read/write through the same boundary regardless of where the
 * bytes physically live (in-process, local fs, S3, ...).
 */

import type { AgentId, ArtifactHandle, Result } from "./common.js";

export type ArtifactState = "draft" | "active" | "archived" | "expired";

export interface ArtifactMeta {
  readonly size: number;
  readonly mediaType: string;
  readonly ownerAgent: AgentId;
  readonly pinnedBy?: readonly AgentId[];
  readonly lifecycle: {
    readonly createdAt: number;
    readonly archiveAfterMs?: number;
    readonly expireAfterMs?: number;
  };
  readonly tags: readonly string[];
}

export interface Artifact {
  readonly handle: ArtifactHandle;
  readonly state: ArtifactState;
  readonly meta: ArtifactMeta;
  /** Lazy fetch; large payloads must not be hauled around in messages. */
  readonly bytes: () => Promise<Uint8Array>;
}

export interface ArtifactInput {
  readonly bytes: Uint8Array;
  readonly meta: Omit<ArtifactMeta, "lifecycle"> & {
    readonly archiveAfterMs?: number;
    readonly expireAfterMs?: number;
  };
}

export interface ArtifactStore {
  put(input: ArtifactInput): Promise<Result<{ readonly handle: ArtifactHandle }>>;
  get(handle: ArtifactHandle): Promise<Result<Artifact>>;
  setState(handle: ArtifactHandle, state: ArtifactState): Promise<Result<void>>;
  list(filter?: ArtifactFilter): Promise<readonly Artifact[]>;
}

export interface ArtifactFilter {
  readonly owner?: AgentId;
  readonly state?: ArtifactState;
  readonly tag?: string;
}
