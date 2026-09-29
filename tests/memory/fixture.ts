import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { id } from "../../packages/contracts/src/index.ts";
import type {
  EffectOptions,
  ExecutionContext,
  MemoryScope,
  Visibility,
} from "../../packages/contracts/src/index.ts";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity.ts";
import { createMemoryRepository } from "../../packages/db/src/repositories/memory.ts";
import { authSchema, user } from "../../packages/db/src/schema/auth.ts";
import { organization } from "../../packages/db/src/schema/core.ts";
import { identitySchema } from "../../packages/db/src/schema/identity.ts";
import { memorySchema } from "../../packages/db/src/schema/memory.ts";
import {
  createArtifactStore,
  createDeterministicFixtureEmbeddings,
  createMemoryStore,
  createS3ObjectStorage,
} from "../../packages/memory/src/index.ts";
import type {
  IngestSource,
  MemoryDependencies,
} from "../../packages/memory/src/types.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required for real PostgreSQL and MinIO memory tests.`
    );
  }
  return value;
};
const databaseUrl = required("MEMORY_TEST_DATABASE_URL");
const storageConfig = {
  accessKeyId: required("MEMORY_TEST_ARTIFACT_ACCESS_KEY_ID"),
  bucket: required("MEMORY_TEST_ARTIFACT_BUCKET"),
  endpoint: required("MEMORY_TEST_ARTIFACT_ENDPOINT"),
  secretAccessKey: required("MEMORY_TEST_ARTIFACT_SECRET_ACCESS_KEY"),
};
export const readOptions = () => ({ deadlineAt: Date.now() + 30_000 });
export const effectOptions = (
  operationId = randomUUID(),
  requestDigest = "caller-digest"
): EffectOptions => ({
  ...readOptions(),
  operationId: id.operation(operationId),
  requestDigest: id.digest(requestDigest),
});
const source = (
  sourceId: string,
  text: string,
  options: {
    version?: string;
    generation?: number | null;
    visibility?: Visibility;
    expiresAt?: number;
  } = {}
): IngestSource => ({
  chunks: [{ id: `${sourceId}-chunk`, text }],
  document: text,
  expectedGeneration: options.generation ?? null,
  observedAt: 1_760_000_000_000,
  sourceId: id.source(sourceId),
  uri: `https://example.test/${sourceId}`,
  version: options.version ?? "v1",
  visibility: options.visibility ?? { kind: "organization" },
  ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
});

export const fixture = async (overrides: Partial<MemoryDependencies> = {}) => {
  const client = postgres(databaseUrl, { max: 5, prepare: false });
  const database = drizzle(client, {
    schema: { ...authSchema, ...identitySchema, ...memorySchema, organization },
  });
  const organizationId = id.organization(`memory-${randomUUID()}`);
  const authUserId = randomUUID();
  await database
    .insert(organization)
    .values({ id: organizationId, name: "Memory tests" });
  await database.insert(user).values({
    email: `${authUserId}@example.test`,
    emailVerified: true,
    id: authUserId,
    name: "Memory actor",
  });
  const identity = createIdentityRepository(database);
  const principal = await identity.provisionHumanPrincipal(
    organizationId,
    authUserId
  );
  const scope: MemoryScope = {
    context: {
      actor: {
        id: id.principal(principal.id),
        kind: "human",
        organizationId,
        state: "active",
      },
    },
    organizationId,
  };
  const repository = createMemoryRepository(database);
  const objects = createS3ObjectStorage(storageConfig);
  const dependencies: MemoryDependencies = {
    embeddings: createDeterministicFixtureEmbeddings(),
    identity,
    objects,
    repository,
    ...overrides,
  };
  const memory = createMemoryStore(dependencies);
  const artifacts = createArtifactStore(dependencies);
  const grant = async (
    sourceId: string,
    enabled = true,
    principalId = principal.id,
    actions: readonly ("read" | "write")[] = ["read", "write"]
  ) => {
    await Promise.all(
      actions.map(async (action) => {
        await identity.setManualGrant(
          organizationId,
          principalId,
          { action, resourceId: sourceId, resourceKind: "memory" },
          enabled
        );
      })
    );
  };
  const add = async (
    sourceId: string,
    text: string,
    options: Parameters<typeof source>[2] = {}
  ) => {
    await grant(sourceId);
    const input = source(sourceId, text, options);
    const result = await memory.ingest(scope, input, effectOptions());
    if (result.status !== "ok") {
      throw new Error(`Fixture ingestion failed ${JSON.stringify(result)}`);
    }
    return { input, result: result.value };
  };
  const secondActor = async (): Promise<{
    scope: MemoryScope;
    authUserId: string;
  }> => {
    const nextUserId = randomUUID();
    await database.insert(user).values({
      email: `${nextUserId}@example.test`,
      emailVerified: true,
      id: nextUserId,
      name: "Second actor",
    });
    const next = await identity.provisionHumanPrincipal(
      organizationId,
      nextUserId
    );
    return {
      authUserId: nextUserId,
      scope: {
        context: {
          actor: {
            id: id.principal(next.id),
            kind: "human",
            organizationId,
            state: "active",
          },
        },
        organizationId,
      },
    };
  };
  return {
    add,
    artifacts,
    authUserId,
    client,
    close: async () => await client.end({ timeout: 2 }),
    database,
    dependencies,
    grant,
    identity,
    memory,
    objects,
    organizationId,
    principal,
    repository,
    scope,
    secondActor,
    source,
  };
};
export const delegatedScope = (
  scope: MemoryScope,
  represented: ExecutionContext["actor"],
  delegation: { id: string; expiresAt: Date }
): MemoryScope => ({
  context: {
    actor: scope.context.actor,
    delegation: {
      actorId: scope.context.actor.id,
      expiresAt: delegation.expiresAt.getTime(),
      id: id.delegation(delegation.id),
      organizationId: scope.organizationId,
      representedId: represented.id,
    },
    represented,
  },
  organizationId: scope.organizationId,
});
