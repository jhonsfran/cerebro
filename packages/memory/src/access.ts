import { createAuthorizationPolicy } from "@cerebro/authorization";
import type {
  Action,
  MemoryScope,
  PortResult,
  ReadOptions,
} from "@cerebro/contracts";
import type { AuthorizationSnapshot } from "@cerebro/db/repositories/identity";
import type {
  MemoryMetadata,
  SourceMetadata,
} from "@cerebro/db/repositories/memory";
import type { StoredVisibility } from "@cerebro/db/schema/memory";

import { bounded, denied } from "./runtime";
import type { MemoryDependencies } from "./types";

export interface AccessView {
  readonly metadata: MemoryMetadata;
  readonly sources: readonly SourceMetadata[];
  readonly recordIds: readonly string[];
  readonly snapshot: AuthorizationSnapshot;
  readonly allows: (
    sourceId: string,
    action: Action,
    visibility?: StoredVisibility
  ) => Promise<boolean>;
}

export const accessView = async (
  dependencies: MemoryDependencies,
  scope: MemoryScope,
  options: ReadOptions
): Promise<PortResult<AccessView>> => {
  const now = dependencies.now ?? Date.now;
  return await bounded(
    options,
    async () => {
      if (scope.organizationId !== scope.context.actor.organizationId) {
        return denied("The actor belongs to another organization.");
      }
      const snapshot = await dependencies.identity.readSnapshot(
        scope.organizationId,
        scope.context.actor.id,
        scope.context.delegation?.id
      );
      if (
        !snapshot.actor ||
        snapshot.actor.state !== "active" ||
        !snapshot.actorDirectoryActive
      ) {
        return denied("The actor is no longer active.");
      }
      const metadata = await dependencies.repository.metadata(
        scope.organizationId
      );
      const byId = new Map(
        metadata.sources.map((source) => [source.id, source])
      );
      const policy = createAuthorizationPolicy(
        { readSnapshot: () => Promise.resolve(snapshot) },
        now
      );
      const grant = async (
        sourceId: string,
        action: Action
      ): Promise<boolean> => {
        const result = await policy.evaluate(
          scope.context,
          action,
          {
            id: sourceId,
            kind: "memory",
            organizationId: scope.organizationId,
          },
          options
        );
        return result.status === "ok" && result.value.decision === "allow";
      };
      const visible = async (
        visibility: StoredVisibility,
        action: Action
      ): Promise<boolean> => {
        if (visibility.kind === "organization") {
          return true;
        }
        if (visibility.kind === "private") {
          return (
            visibility.ownerId ===
            (scope.context.represented?.id ?? scope.context.actor.id)
          );
        }
        return await grant(visibility.grantId, action);
      };
      const active = (
        source: SourceMetadata | undefined
      ): source is SourceMetadata =>
        !!source &&
        source.state === "active" &&
        (!source.expiresAt || source.expiresAt.getTime() > now());
      const accessible = async (
        sourceId: string,
        action: Action,
        path: Set<string>
      ): Promise<boolean> => {
        const source = byId.get(sourceId);
        if (
          !active(source) ||
          path.has(sourceId) ||
          !(await grant(sourceId, action)) ||
          !(await visible(source.visibility, action))
        ) {
          return false;
        }
        const next = new Set(path).add(sourceId);
        const results = await Promise.all(
          metadata.dependencies
            .filter((dependency) => dependency.derivedSourceId === sourceId)
            .map(async (dependency) => {
              const parent = byId.get(dependency.sourceId);
              return (
                active(parent) &&
                parent.version === dependency.sourceVersion &&
                (await accessible(dependency.sourceId, "read", next))
              );
            })
        );
        return results.every(Boolean);
      };
      const allows = async (
        sourceId: string,
        action: Action,
        visibility?: StoredVisibility
      ) =>
        (await accessible(sourceId, action, new Set())) &&
        (!visibility || (await visible(visibility, action)));
      const sourceResults = await Promise.all(
        metadata.sources.map(async (source) => await allows(source.id, "read"))
      );
      const sources = metadata.sources.filter(
        (_, index) => sourceResults[index]
      );
      const allowedSources = new Map(
        sources.map((source) => [source.id, source])
      );
      const recordResults = await Promise.all(
        metadata.records.map(
          async (record) =>
            allowedSources.get(record.sourceId)?.version ===
              record.sourceVersion && (await visible(record.visibility, "read"))
        )
      );
      const recordIds = metadata.records
        .filter((_, index) => recordResults[index])
        .map((record) => record.id);
      return {
        status: "ok",
        value: { allows, metadata, recordIds, snapshot, sources },
      };
    },
    now
  );
};

export const authorizeNewSource = async (
  dependencies: MemoryDependencies,
  scope: MemoryScope,
  sourceId: string,
  visibility: StoredVisibility,
  options: ReadOptions
): Promise<PortResult<void>> => {
  const view = await accessView(dependencies, scope, options);
  if (view.status !== "ok") {
    return view;
  }
  const policy = createAuthorizationPolicy(
    { readSnapshot: () => Promise.resolve(view.value.snapshot) },
    dependencies.now ?? Date.now
  );
  const check = async (resourceId: string) => {
    const result = await policy.evaluate(
      scope.context,
      "write",
      { id: resourceId, kind: "memory", organizationId: scope.organizationId },
      options
    );
    return result.status === "ok" && result.value.decision === "allow";
  };
  if (!(await check(sourceId))) {
    return denied("The actor has no current source write grant.");
  }
  if (
    visibility.kind === "private" &&
    visibility.ownerId !==
      (scope.context.represented?.id ?? scope.context.actor.id)
  ) {
    return denied("A private source must belong to the effective principal.");
  }
  if (visibility.kind === "grant" && !(await check(visibility.grantId))) {
    return denied("The actor has no current visibility grant.");
  }
  const current = view.value.metadata.sources.find(
    (source) => source.id === sourceId
  );
  if (
    current &&
    current.state === "active" &&
    !(await view.value.allows(sourceId, "write"))
  ) {
    return denied("The current source cannot be replaced by this principal.");
  }
  return { status: "ok", value: undefined };
};
