import { id } from "@cerebro/contracts";
import type {
  ArtifactRef,
  MemoryScope,
  PortResult,
  ReadOptions,
} from "@cerebro/contracts";
import type { ArtifactMetadata } from "@cerebro/db/repositories/memory";

import { accessView } from "./access";
import {
  bounded,
  denied,
  effectBinding,
  fingerprint,
  interrupted,
  invalid,
} from "./runtime";
import type { ManagedArtifactStore, MemoryDependencies } from "./types";

export const artifactRef = (artifact: ArtifactMetadata): ArtifactRef => ({
  artifactId: id.artifact(artifact.id),
  organizationId: id.organization(artifact.organizationId),
  provenance: {
    observedAt: artifact.observedAt.getTime(),
    sourceId: id.source(artifact.sourceId),
    sourceUri: artifact.sourceUri,
    sourceVersion: artifact.sourceVersion,
  },
  visibility:
    artifact.visibility.kind === "private"
      ? { kind: "private", ownerId: id.principal(artifact.visibility.ownerId) }
      : artifact.visibility,
});

const authorizeArtifact = async (
  dependencies: MemoryDependencies,
  scope: MemoryScope,
  artifact: ArtifactMetadata,
  options: ReadOptions,
  action: "read" | "write"
): Promise<PortResult<void>> => {
  const access = await accessView(dependencies, scope, options);
  if (access.status !== "ok") {
    return access;
  }
  const source = access.value.metadata.sources.find(
    (entry) => entry.id === artifact.sourceId
  );
  if (
    !source ||
    source.version !== artifact.sourceVersion ||
    source.uri !== artifact.sourceUri ||
    source.observedAt.getTime() !== artifact.observedAt.getTime() ||
    !(await access.value.allows(source.id, action, artifact.visibility))
  ) {
    return denied(
      "The artifact is not accessible under current source policy."
    );
  }
  return { status: "ok", value: undefined };
};

export const createArtifactStore = (
  dependencies: MemoryDependencies
): ManagedArtifactStore => {
  const now = dependencies.now ?? Date.now;
  return {
    async cleanup(options) {
      return await bounded(
        options,
        async () => ({
          status: "ok",
          value: await dependencies.repository.cleanup(
            async (key) => await dependencies.objects.delete(key, options),
            new Date(now())
          ),
        }),
        now
      );
    },
    async delete(scope, ref, options) {
      let effectStarted = false;
      return await bounded(
        options,
        async () => {
          const stored = await dependencies.repository.artifact(
            scope.organizationId,
            ref.artifactId
          );
          if (stored) {
            const allowed = await authorizeArtifact(
              dependencies,
              scope,
              stored,
              options,
              "write"
            );
            if (allowed.status !== "ok") {
              return allowed;
            }
          } else {
            const receipt = await dependencies.repository.operationSource(
              scope.organizationId,
              options.operationId
            );
            if (!receipt) {
              return { resource: "artifact", status: "not-found" };
            }
            const access = await accessView(dependencies, scope, options);
            if (access.status !== "ok") {
              return access;
            }
            if (
              !(await access.value.allows(
                receipt.sourceId,
                "write",
                receipt.visibility
              ))
            ) {
              return denied("The deletion receipt is no longer accessible.");
            }
          }
          const binding = await effectBinding(
            scope,
            "artifact.delete",
            { artifactId: ref.artifactId },
            options
          );
          effectStarted = true;
          const result = await bounded(
            options,
            async () =>
              await dependencies.repository.deleteArtifact(
                binding,
                ref.artifactId
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
          return { status: "ok", value: undefined };
        },
        now,
        () => (effectStarted ? options : undefined)
      );
    },
    async put(scope, bytes, metadata, options) {
      let effectStarted = false;
      return await bounded(
        options,
        async () => {
          if (metadata.organizationId !== scope.organizationId) {
            return invalid("The artifact organization must match its scope.");
          }
          const access = await accessView(dependencies, scope, options);
          if (access.status !== "ok") {
            return access;
          }
          const source = access.value.metadata.sources.find(
            (entry) => entry.id === metadata.provenance.sourceId
          );
          if (
            !source ||
            source.version !== metadata.provenance.sourceVersion ||
            source.uri !== metadata.provenance.sourceUri ||
            source.observedAt.getTime() !== metadata.provenance.observedAt
          ) {
            return invalid(
              "The artifact provenance must match the current stored source exactly."
            );
          }
          if (
            !(await access.value.allows(
              source.id,
              "write",
              metadata.visibility
            ))
          ) {
            return denied("The actor has no current artifact write access.");
          }
          const bytesFingerprint = await fingerprint(bytes);
          const binding = await effectBinding(
            scope,
            "artifact.put",
            { bytesFingerprint, metadata },
            options
          );
          const objectKey = `${scope.organizationId}/${source.id}/${crypto.randomUUID()}`;
          const check = interrupted(options, now);
          if (check.status !== "ok") {
            return check;
          }
          effectStarted = true;
          const result = await bounded(
            options,
            async () =>
              await dependencies.repository.registerArtifact(
                binding,
                {
                  fingerprint: bytesFingerprint,
                  id: `${options.operationId}:artifact`,
                  objectKey,
                  observedAt: source.observedAt,
                  organizationId: scope.organizationId,
                  sourceId: source.id,
                  sourceUri: source.uri,
                  sourceVersion: source.version,
                  visibility: metadata.visibility,
                },
                source.generation,
                async () =>
                  await dependencies.objects.put(objectKey, bytes, options)
              ),
            now,
            options
          );
          if (result.status !== "ok") {
            return result;
          }
          const stored = await dependencies.repository.artifact(
            scope.organizationId,
            result.value.artifactId ?? ""
          );
          if (!stored) {
            return { resource: "artifact", status: "not-found" };
          }
          const final = await authorizeArtifact(
            dependencies,
            scope,
            stored,
            options,
            "write"
          );
          if (final.status !== "ok") {
            return final;
          }
          return { status: "ok", value: artifactRef(stored) };
        },
        now,
        () => (effectStarted ? options : undefined)
      );
    },
    async read(scope, ref, options) {
      return await bounded(
        options,
        async () => {
          const stored = await dependencies.repository.artifact(
            scope.organizationId,
            ref.artifactId
          );
          if (!stored) {
            return { resource: "artifact", status: "not-found" };
          }
          const allowed = await authorizeArtifact(
            dependencies,
            scope,
            stored,
            options,
            "read"
          );
          if (allowed.status !== "ok") {
            return allowed;
          }
          const bytes = await dependencies.objects.read(
            stored.objectKey,
            options
          );
          const canonical = await dependencies.repository.artifact(
            scope.organizationId,
            stored.id
          );
          if (
            !canonical ||
            canonical.objectKey !== stored.objectKey ||
            canonical.fingerprint !== stored.fingerprint
          ) {
            return { resource: "artifact", status: "not-found" };
          }
          const final = await authorizeArtifact(
            dependencies,
            scope,
            canonical,
            options,
            "read"
          );
          if (final.status !== "ok") {
            return final;
          }
          if ((await fingerprint(bytes)) !== stored.fingerprint) {
            return {
              code: "provider-unavailable",
              reason:
                "The artifact content does not match its stored fingerprint.",
              status: "unavailable",
            };
          }
          return { status: "ok", value: bytes };
        },
        now
      );
    },
  };
};
