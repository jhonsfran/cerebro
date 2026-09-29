import type {
  ArtifactStore,
  MemoryScope,
  MemoryStore,
  PortResult,
  ReadOptions,
  EffectOptions,
  SourceId,
  Visibility,
} from "@cerebro/contracts";
import type { IdentityRepository } from "@cerebro/db/repositories/identity";
import type { MemoryRepository } from "@cerebro/db/repositories/memory";

export interface EmbeddingPort {
  readonly model: string;
  readonly dimensions: number;
  readonly embed: (
    texts: readonly string[],
    options: ReadOptions
  ) => Promise<PortResult<readonly (readonly number[])[]>>;
}
export interface IngestSource {
  readonly sourceId: SourceId;
  readonly version: string;
  readonly uri: string;
  readonly observedAt: number;
  readonly visibility: Visibility;
  readonly document: string;
  readonly chunks: readonly { readonly id: string; readonly text: string }[];
  readonly expiresAt?: number;
  readonly expectedGeneration: number | null;
}
export interface PublishedSource {
  readonly sourceId: SourceId;
  readonly version: string;
  readonly generation: number;
}
export interface MemoryService extends MemoryStore {
  readonly ingest: (
    scope: MemoryScope,
    source: IngestSource,
    options: EffectOptions
  ) => Promise<PortResult<PublishedSource>>;
  readonly revoke: (
    scope: MemoryScope,
    sourceId: SourceId,
    options: EffectOptions
  ) => Promise<PortResult<{ readonly removed: number }>>;
}
export interface MemoryDependencies {
  readonly repository: MemoryRepository;
  readonly identity: Pick<IdentityRepository, "readSnapshot">;
  readonly embeddings: EmbeddingPort;
  readonly objects: ObjectStorage;
  readonly now?: () => number;
  readonly retrievalMode?: "full-text" | "semantic" | "hybrid";
}
export interface ObjectStorage {
  readonly put: (
    key: string,
    bytes: Uint8Array,
    options: ReadOptions
  ) => Promise<void>;
  readonly read: (key: string, options: ReadOptions) => Promise<Uint8Array>;
  readonly delete: (key: string, options: ReadOptions) => Promise<void>;
}
export interface ManagedArtifactStore extends ArtifactStore {
  readonly cleanup: (
    options: ReadOptions
  ) => Promise<PortResult<{ deleted: number; failed: number }>>;
}

export type { MemoryRecord } from "@cerebro/contracts";
