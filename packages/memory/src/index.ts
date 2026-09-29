import { forget } from "./forget";
import { ingest } from "./ingest";
import { remember } from "./remember";
import { retrieve } from "./retrieve";
import type { MemoryDependencies, MemoryService } from "./types";

export const createMemoryStore = (
  dependencies: MemoryDependencies
): MemoryService => ({
  forget: async (scope, sourceId, options) =>
    await forget(dependencies, scope, sourceId, options),
  ingest: async (scope, source, options) =>
    await ingest(dependencies, scope, source, options),
  remember: async (scope, record, options) =>
    await remember(dependencies, scope, record, options),
  retrieve: async (query, options) =>
    await retrieve(dependencies, query, options),
  revoke: async (scope, sourceId, options) =>
    await forget(dependencies, scope, sourceId, options, "revoked"),
});

export { createArtifactStore } from "./artifact-store";
export {
  createHttpEmbeddings,
  createDeterministicFixtureEmbeddings,
} from "./embeddings";
export { createS3ObjectStorage } from "./object-storage";
export type {
  EmbeddingPort,
  IngestSource,
  MemoryDependencies,
  MemoryService,
  ObjectStorage,
  ManagedArtifactStore,
} from "./types";
