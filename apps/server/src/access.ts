import {
  createAuthorizationPolicy,
  createAuthorizationService,
} from "@cerebro/authorization";
import type {
  AuthorizationPolicy,
  ContentDependencies,
  EntitlementPolicy,
  ExecutionContext,
  PortResult,
  ReadOptions,
} from "@cerebro/contracts";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type { Database } from "@cerebro/db";
import { withDatabase } from "@cerebro/db";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import { findConnectorTool } from "@cerebro/db/repositories/catalog";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import { createMemoryRepository } from "@cerebro/db/repositories/memory";
import { memoryArtifact } from "@cerebro/db/schema/memory";
import {
  createArtifactStore,
  createMemoryStore,
  createS3ObjectStorage,
} from "@cerebro/memory";
import { accessView } from "@cerebro/memory/access";
import { artifactRef } from "@cerebro/memory/artifact-store";
import { bindRegisteredTool } from "@cerebro/tools/registry";
import { and, asc, eq, like } from "drizzle-orm";
import { Effect } from "effect";

import type { WorkerEnv } from "./bindings";
import {
  createCatalogRegistry,
  parseCatalogTool,
  runtimeConfiguration,
} from "./config";

export const memoryDependencies = (env: WorkerEnv, database: Database) => ({
  identity: createIdentityRepository(database),
  objects: createS3ObjectStorage(runtimeConfiguration(env).artifacts),
  repository: createMemoryRepository(database),
  retrievalMode: "full-text" as const,
});
export const createMemoryServices = (env: WorkerEnv, database: Database) => {
  const dependencies = memoryDependencies(env, database);
  return {
    artifacts: createArtifactStore(dependencies),
    identity: dependencies.identity,
    memory: createMemoryStore(dependencies),
  };
};
export const createCurrentAuthorization = (
  env: WorkerEnv
): AuthorizationPolicy => ({
  evaluate: (context, action, resource, options) =>
    withDatabase(env, (database) =>
      createAuthorizationPolicy(createIdentityRepository(database)).evaluate(
        context,
        action,
        resource,
        options
      )
    ),
});
export const createCurrentEntitlements = (
  env: Pick<WorkerEnv, "DATABASE_URL" | "DEPLOY_MODE" | "RUNTIME_CONFIG_JSON">
): EntitlementPolicy => ({
  check: (request, options) =>
    withDatabase(env, async (database) => {
      const current = await createAgentRepository(database).get(
        request.organizationId,
        request.agentId,
        "latest",
        options
      );
      if (current.status !== "ok") {
        return current;
      }
      const configured = runtimeConfiguration(env);
      let allowed = false;
      if (request.kind === "model") {
        allowed =
          current.value.model === request.model &&
          configured.models.some((model) => model.id === request.model);
      } else if (current.value.enabledToolIds.includes(request.tool.id)) {
        const definition = await findConnectorTool(
          database,
          request.organizationId,
          request.tool.id
        );
        if (definition !== undefined) {
          const registry = createCatalogRegistry(
            [parseCatalogTool(definition)],
            configured.mode
          );
          const entry = registry.get(request.tool.id);
          if (entry) {
            const registered = await Effect.runPromise(
              bindRegisteredTool(entry)
            );
            allowed =
              canonicalToolArguments(registered) ===
              canonicalToolArguments(request.tool);
          }
        }
      }
      return {
        status: "ok",
        value: allowed
          ? {
              decision: "allow",
              policyVersion: `agent:${current.value.version}`,
            }
          : {
              decision: "deny",
              policyVersion: `agent:${current.value.version}`,
              reason: "The current agent does not enable this capability.",
            },
      };
    }),
});
export const checkContentDependencies = async (
  env: WorkerEnv,
  database: Database,
  context: ExecutionContext,
  dependencies: ContentDependencies,
  options: ReadOptions
): Promise<PortResult<void>> => {
  const current = await accessView(
    memoryDependencies(env, database),
    { context, organizationId: context.actor.organizationId },
    options
  );
  if (current.status !== "ok") {
    return current;
  }
  const policy = createAuthorizationPolicy(createIdentityRepository(database));
  const [sources, tools] = await Promise.all([
    Promise.all(
      dependencies.sourceIds.map((sourceId) =>
        current.value.allows(sourceId, "read")
      )
    ),
    Promise.all(
      dependencies.toolIds.map((toolId) =>
        policy.evaluate(
          context,
          "read",
          {
            id: toolId,
            kind: "tool",
            organizationId: context.actor.organizationId,
          },
          options
        )
      )
    ),
  ]);
  const failed = tools.find((result) => result.status !== "ok");
  if (failed) {
    return failed;
  }
  if (
    !sources.every(Boolean) ||
    !tools.every(
      (result) => result.status === "ok" && result.value.decision === "allow"
    )
  ) {
    return {
      code: "unauthorized",
      reason: "A content dependency is no longer accessible.",
      status: "denied",
    };
  }
  return { status: "ok", value: undefined };
};
export const readSource = async (
  env: WorkerEnv,
  database: Database,
  context: ExecutionContext,
  sourceId: string
) => {
  const dependencies = memoryDependencies(env, database);
  const options = { deadlineAt: Date.now() + 10_000 };
  const view = await accessView(
    dependencies,
    { context, organizationId: context.actor.organizationId },
    options
  );
  if (view.status !== "ok") {
    return view;
  }
  const source = view.value.sources.find((entry) => entry.id === sourceId);
  if (!source) {
    return {
      code: "unauthorized" as const,
      reason: "The source is no longer accessible.",
      status: "denied" as const,
    };
  }
  const [artifact] = await database
    .select()
    .from(memoryArtifact)
    .where(
      and(
        eq(memoryArtifact.organizationId, context.actor.organizationId),
        eq(memoryArtifact.sourceId, sourceId),
        eq(memoryArtifact.sourceVersion, source.version),
        like(memoryArtifact.id, "%:original")
      )
    )
    .orderBy(asc(memoryArtifact.createdAt))
    .limit(1);
  if (!artifact) {
    return { resource: "source-document", status: "not-found" as const };
  }
  const document = await createArtifactStore(dependencies).read(
    { context, organizationId: context.actor.organizationId },
    artifactRef(artifact),
    options
  );
  if (document.status !== "ok") {
    return document;
  }
  return {
    status: "ok" as const,
    value: {
      sourceId,
      sourceVersion: source.version,
      text: new TextDecoder().decode(document.value),
      title: source.uri,
    },
  };
};
export const createCurrentAuthority = (env: Pick<WorkerEnv, "DATABASE_URL">) =>
  createAuthorizationService({
    readSnapshot: (organizationId, actorId, delegationId) =>
      withDatabase(env, (database) =>
        createIdentityRepository(database).readSnapshot(
          organizationId,
          actorId,
          delegationId
        )
      ),
  });
