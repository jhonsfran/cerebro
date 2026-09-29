import { id } from "@cerebro/contracts";
import type {
  MemoryScope,
  EffectOptions,
  PortResult,
} from "@cerebro/contracts";

import { authorizeNewSource } from "./access";
import { validEmbedding } from "./embeddings";
import {
  bounded,
  effectBinding,
  fingerprint,
  interrupted,
  invalid,
} from "./runtime";
import type {
  IngestSource,
  MemoryDependencies,
  PublishedSource,
} from "./types";

export const ingest = async (
  dependencies: MemoryDependencies,
  scope: MemoryScope,
  input: IngestSource,
  options: EffectOptions
): Promise<PortResult<PublishedSource>> => {
  const now = dependencies.now ?? Date.now;
  if (
    !input.version.trim() ||
    !input.uri.trim() ||
    !input.document.trim() ||
    !Number.isFinite(input.observedAt) ||
    input.chunks.length === 0 ||
    input.chunks.some((chunk) => !chunk.id.trim() || !chunk.text.trim()) ||
    new Set(input.chunks.map((chunk) => chunk.id)).size !==
      input.chunks.length ||
    (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt)) ||
    (input.expectedGeneration !== null &&
      (!Number.isSafeInteger(input.expectedGeneration) ||
        input.expectedGeneration < 1))
  ) {
    return invalid(
      "A source needs a document, unique nonempty chunks, valid metadata, and an expected generation."
    );
  }
  let effectStarted = false;
  return await bounded(
    options,
    async () => {
      const allowed = await authorizeNewSource(
        dependencies,
        scope,
        input.sourceId,
        input.visibility,
        options
      );
      if (allowed.status !== "ok") {
        return allowed;
      }
      const vectors = await dependencies.embeddings.embed(
        input.chunks.map((chunk) => chunk.text),
        options
      );
      if (vectors.status !== "ok") {
        return vectors;
      }
      if (
        vectors.value.length !== input.chunks.length ||
        vectors.value.some(
          (vector) =>
            !validEmbedding(vector, dependencies.embeddings.dimensions)
        )
      ) {
        return invalid("The embedding provider returned invalid vectors.");
      }
      const fresh = await authorizeNewSource(
        dependencies,
        scope,
        input.sourceId,
        input.visibility,
        options
      );
      if (fresh.status !== "ok") {
        return fresh;
      }
      const check = interrupted(options, now);
      if (check.status !== "ok") {
        return check;
      }
      const bytes = new TextEncoder().encode(input.document);
      const contentFingerprint = await fingerprint({
        chunks: input.chunks,
        document: input.document,
        expiresAt: input.expiresAt ?? null,
        observedAt: input.observedAt,
        uri: input.uri,
        version: input.version,
        visibility: input.visibility,
      });
      const binding = await effectBinding(scope, "ingest", input, options);
      const objectKey = crypto.randomUUID();
      const originalArtifact = {
        fingerprint: await fingerprint(bytes),
        id: `${options.operationId}:original`,
        objectKey,
        observedAt: new Date(input.observedAt),
        organizationId: scope.organizationId,
        sourceId: input.sourceId,
        sourceUri: input.uri,
        sourceVersion: input.version,
        visibility: input.visibility,
      };
      effectStarted = true;
      const result = await bounded(
        options,
        async () =>
          await dependencies.repository.publish(
            binding,
            {
              expectedGeneration: input.expectedGeneration,
              originalArtifact,
              records: input.chunks.map((chunk, index) => ({
                content: chunk.text,
                embedding: [...(vectors.value[index] ?? [])],
                embeddingDimensions: dependencies.embeddings.dimensions,
                embeddingModel: dependencies.embeddings.model,
                id: chunk.id,
                kind: "source-chunk",
                observedAt: new Date(input.observedAt),
                organizationId: scope.organizationId,
                sourceId: input.sourceId,
                sourceUri: input.uri,
                sourceVersion: input.version,
                visibility: input.visibility,
              })),
              source: {
                expiresAt:
                  input.expiresAt === undefined
                    ? null
                    : new Date(input.expiresAt),
                fingerprint: contentFingerprint,
                id: input.sourceId,
                observedAt: new Date(input.observedAt),
                organizationId: scope.organizationId,
                ownerId:
                  scope.context.represented?.id ?? scope.context.actor.id,
                state: "active",
                uri: input.uri,
                version: input.version,
                visibility: input.visibility,
              },
            },
            async () =>
              await dependencies.objects.put(objectKey, bytes, options)
          ),
        now,
        options
      );
      if (result.status !== "ok") {
        return result;
      }
      if (interrupted(options, now).status === "ok") {
        await dependencies.repository.cleanup(
          async (key) => await dependencies.objects.delete(key, options),
          new Date(now())
        );
      }
      const current = await dependencies.repository.source(
        scope.organizationId,
        input.sourceId
      );
      if (
        !current ||
        current.state !== "active" ||
        current.version !== input.version ||
        current.fingerprint !== contentFingerprint
      ) {
        return {
          code: "version-mismatch",
          reason: "The published source has since changed.",
          status: "conflict",
        };
      }
      return {
        status: "ok",
        value: {
          generation: current.generation,
          sourceId: id.source(current.id),
          version: current.version,
        },
      };
    },
    now,
    () => (effectStarted ? options : undefined)
  );
};
