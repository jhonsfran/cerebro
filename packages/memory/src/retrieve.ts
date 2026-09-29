import { id } from "@cerebro/contracts";
import type {
  MemoryHit,
  MemoryQuery,
  MemoryRecord,
  PortResult,
  ReadOptions,
} from "@cerebro/contracts";
import type { StoredRecord } from "@cerebro/db/repositories/memory";

import { accessView } from "./access";
import { validEmbedding } from "./embeddings";
import { bounded, invalid } from "./runtime";
import type { MemoryDependencies } from "./types";

export const publicRecord = (
  record: StoredRecord,
  dependentSourceIds: readonly string[] = record.dependencySourceIds
): MemoryRecord => {
  const base = {
    id: record.id,
    provenance: {
      observedAt: record.observedAt.getTime(),
      sourceId: id.source(record.sourceId),
      sourceUri: record.sourceUri,
      sourceVersion: record.sourceVersion,
    },
    text: record.content,
    visibility:
      record.visibility.kind === "private"
        ? {
            kind: "private" as const,
            ownerId: id.principal(record.visibility.ownerId),
          }
        : record.visibility,
  };
  if (record.kind === "conversation-summary") {
    return {
      ...base,
      dependentSourceIds: dependentSourceIds.map(id.source),
      kind: record.kind,
    };
  }
  return { ...base, kind: record.kind };
};

export const retrieve = async (
  dependencies: MemoryDependencies,
  query: MemoryQuery,
  options: ReadOptions
): Promise<PortResult<readonly MemoryHit[]>> => {
  if (
    !query.text.trim() ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100
  ) {
    return invalid("Retrieval needs text and a limit from 1 to 100.");
  }
  const now = dependencies.now ?? Date.now;
  return await bounded(
    options,
    async () => {
      const beforeEmbedding = await accessView(dependencies, query, options);
      if (beforeEmbedding.status !== "ok") {
        return beforeEmbedding;
      }
      if (beforeEmbedding.value.recordIds.length === 0) {
        return { status: "ok", value: [] };
      }
      let vector: readonly number[] = [];
      if (dependencies.retrievalMode !== "full-text") {
        const vectors = await dependencies.embeddings.embed(
          [query.text],
          options
        );
        if (vectors.status !== "ok") {
          return vectors;
        }
        const [queryVector] = vectors.value;
        if (
          vectors.value.length !== 1 ||
          !validEmbedding(queryVector, dependencies.embeddings.dimensions)
        ) {
          return invalid(
            "The embedding provider returned an invalid query vector."
          );
        }
        vector = queryVector;
      }
      const access = await accessView(dependencies, query, options);
      if (access.status !== "ok") {
        return access;
      }
      const records = await dependencies.repository.search({
        dimensions: dependencies.embeddings.dimensions,
        limit: query.limit,
        mode: dependencies.retrievalMode ?? "hybrid",
        model: dependencies.embeddings.model,
        now: new Date(now()),
        organizationId: query.organizationId,
        records: access.value.metadata.records.filter((record) =>
          access.value.recordIds.includes(record.id)
        ),
        sources: access.value.sources,
        text: query.text,
        vector,
      });
      const final = await accessView(dependencies, query, options);
      if (final.status !== "ok") {
        return final;
      }
      const finalSources = new Map(
        final.value.sources.map((source) => [source.id, source])
      );
      const checked = await Promise.all(
        records.map(async (record): Promise<MemoryHit | undefined> => {
          const source = finalSources.get(record.sourceId);
          const initialSource = access.value.sources.find(
            (entry) => entry.id === record.sourceId
          );
          if (
            !source ||
            source.version !== record.sourceVersion ||
            source.generation !== initialSource?.generation ||
            !final.value.recordIds.includes(record.id) ||
            !(await final.value.allows(
              record.sourceId,
              "read",
              record.visibility
            ))
          ) {
            return;
          }
          const publicValue = publicRecord(record);
          return { citation: publicValue.provenance, record: publicValue };
        })
      );
      const hits = checked.filter((hit): hit is MemoryHit => hit !== undefined);
      return { status: "ok", value: hits };
    },
    now
  );
};
