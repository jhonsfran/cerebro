import type {
  MemoryRecord,
  MemoryScope,
  EffectOptions,
  PortResult,
} from "@cerebro/contracts";
import type {
  SourceDependency,
  SourceMetadata,
} from "@cerebro/db/repositories/memory";

import { accessView } from "./access";
import { validEmbedding } from "./embeddings";
import { publicRecord } from "./retrieve";
import {
  bounded,
  denied,
  effectBinding,
  interrupted,
  invalid,
} from "./runtime";
import type { MemoryDependencies } from "./types";

const matchesProvenance = (
  source: SourceMetadata,
  record: MemoryRecord
): boolean =>
  source.version === record.provenance.sourceVersion &&
  source.uri === record.provenance.sourceUri &&
  source.observedAt.getTime() === record.provenance.observedAt;

const readRemembered = async (
  dependencies: MemoryDependencies,
  scope: MemoryScope,
  record: MemoryRecord,
  options: EffectOptions
): Promise<PortResult<MemoryRecord>> => {
  const access = await accessView(dependencies, scope, options);
  if (access.status !== "ok") {
    return access;
  }
  const metadata = access.value.metadata.records.find(
    (entry) =>
      entry.id === record.id && access.value.recordIds.includes(entry.id)
  );
  if (!metadata) {
    return denied("The remembered record is no longer accessible.");
  }
  const [stored] = await dependencies.repository.search({
    dimensions: dependencies.embeddings.dimensions,
    limit: 1,
    mode: "record",
    model: dependencies.embeddings.model,
    now: new Date((dependencies.now ?? Date.now)()),
    organizationId: scope.organizationId,
    records: [metadata],
    sources: access.value.sources,
    text: "",
    vector: [],
  });
  if (!stored) {
    return { resource: "memory", status: "not-found" };
  }
  const final = await accessView(dependencies, scope, options);
  if (final.status !== "ok") {
    return final;
  }
  const source = final.value.sources.find(
    (entry) => entry.id === stored.sourceId
  );
  const initialSource = access.value.sources.find(
    (entry) => entry.id === stored.sourceId
  );
  if (
    !source ||
    source.version !== stored.sourceVersion ||
    source.generation !== initialSource?.generation ||
    !final.value.recordIds.includes(stored.id) ||
    !(await final.value.allows(stored.sourceId, "read", stored.visibility))
  ) {
    return denied("The memory record changed while it was read.");
  }
  return { status: "ok", value: publicRecord(stored) };
};

export const remember = async (
  dependencies: MemoryDependencies,
  scope: MemoryScope,
  record: MemoryRecord,
  options: EffectOptions
): Promise<PortResult<MemoryRecord>> => {
  if (!record.id.trim() || !record.text.trim()) {
    return invalid("A memory record needs an ID and text.");
  }
  const now = dependencies.now ?? Date.now;
  let effectStarted = false;
  return await bounded(
    options,
    async () => {
      const first = await accessView(dependencies, scope, options);
      if (first.status !== "ok") {
        return first;
      }
      if (
        !(await first.value.allows(
          record.provenance.sourceId,
          "write",
          record.visibility
        )) ||
        !(await first.value.allows(record.provenance.sourceId, "read"))
      ) {
        return denied("The record needs current source read and write access.");
      }
      const vectors = await dependencies.embeddings.embed(
        [record.text],
        options
      );
      if (vectors.status !== "ok") {
        return vectors;
      }
      const [vector] = vectors.value;
      if (
        vectors.value.length !== 1 ||
        !validEmbedding(vector, dependencies.embeddings.dimensions)
      ) {
        return invalid("The embedding provider returned an invalid vector.");
      }
      const access = await accessView(dependencies, scope, options);
      if (access.status !== "ok") {
        return access;
      }
      const source = access.value.sources.find(
        (entry) => entry.id === record.provenance.sourceId
      );
      if (!source || !matchesProvenance(source, record)) {
        return invalid(
          "The record provenance must match the current stored source exactly."
        );
      }
      if (!(await access.value.allows(source.id, "write", record.visibility))) {
        return denied("The current write policy denies this memory record.");
      }
      const dependenciesInput =
        record.kind === "conversation-summary" ? record.dependentSourceIds : [];
      const sourceDependencies = dependenciesInput.map(
        (sourceId): SourceDependency | undefined => {
          const parent = access.value.sources.find(
            (entry) => entry.id === sourceId
          );
          return parent
            ? {
                derivedSourceId: source.id,
                organizationId: scope.organizationId,
                sourceId: parent.id,
                sourceVersion: parent.version,
              }
            : undefined;
        }
      );
      if (sourceDependencies.some((dependency) => !dependency)) {
        return denied("Every summary dependency needs current read access.");
      }
      const currentDependencies = sourceDependencies.filter(
        (dependency): dependency is SourceDependency => dependency !== undefined
      );
      if (record.kind === "remembered-fact") {
        const chunks = await dependencies.repository.search({
          dimensions: dependencies.embeddings.dimensions,
          limit: 100,
          mode: "hybrid",
          model: dependencies.embeddings.model,
          now: new Date(now()),
          organizationId: scope.organizationId,
          records: access.value.metadata.records.filter((metadataRecord) =>
            access.value.recordIds.includes(metadataRecord.id)
          ),
          sources: [source],
          text: record.text,
          vector,
        });
        if (
          !chunks.some(
            (chunk) =>
              chunk.kind === "source-chunk" &&
              chunk.content.includes(record.text)
          )
        ) {
          return invalid(
            "A remembered fact must quote current source content."
          );
        }
      }
      const binding = await effectBinding(scope, "remember", record, options);
      const check = interrupted(options, now);
      if (check.status !== "ok") {
        return check;
      }
      effectStarted = true;
      const result = await bounded(
        options,
        async () =>
          await dependencies.repository.remember(
            binding,
            {
              content: record.text,
              dependencySourceIds: dependenciesInput,
              embedding: vector,
              embeddingDimensions: dependencies.embeddings.dimensions,
              embeddingModel: dependencies.embeddings.model,
              id: record.id,
              kind: record.kind,
              observedAt: source.observedAt,
              organizationId: scope.organizationId,
              sourceId: source.id,
              sourceUri: source.uri,
              sourceVersion: source.version,
              visibility: record.visibility,
            },
            currentDependencies,
            source.generation
          ),
        now,
        options
      );
      if (result.status !== "ok") {
        return result;
      }
      return await readRemembered(dependencies, scope, record, options);
    },
    now,
    () => (effectStarted ? options : undefined)
  );
};
