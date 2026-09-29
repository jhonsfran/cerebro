import { and, eq, inArray, lte, sql } from "drizzle-orm";

import type { Database } from "../index";
import {
  memoryArtifact,
  memoryArtifactDelete,
  memoryDependency,
  memoryOperation,
  memoryRecord,
  memorySource,
} from "../schema/memory";
import type { StoredVisibility } from "../schema/memory";

export type SourceMetadata = typeof memorySource.$inferSelect;
export type ArtifactMetadata = typeof memoryArtifact.$inferSelect;
export type StoredRecord = typeof memoryRecord.$inferSelect;
export type SourceDependency = typeof memoryDependency.$inferSelect;
export type MemoryTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
export interface RecordMetadata {
  id: string;
  sourceId: string;
  sourceVersion: string;
  visibility: StoredVisibility;
}
export interface MemoryMetadata {
  sources: readonly SourceMetadata[];
  records: readonly RecordMetadata[];
  dependencies: readonly SourceDependency[];
}
export interface EffectBinding {
  id: string;
  organizationId: string;
  actorBinding: string;
  principalId: string;
  kind: string;
  requestDigest: string;
  fingerprint: string;
}
export interface EffectReceipt {
  sourceId?: string;
  recordId?: string;
  artifactId?: string;
  removed?: number;
}
export type MutationResult =
  | { status: "ok"; value: EffectReceipt }
  | {
      status: "conflict";
      code: "digest-mismatch" | "version-mismatch" | "already-final";
      reason: string;
    };
export interface Publication {
  source: Omit<
    typeof memorySource.$inferInsert,
    "generation" | "createdAt" | "updatedAt"
  >;
  expectedGeneration: number | null;
  originalArtifact?: typeof memoryArtifact.$inferInsert;
  records: readonly (typeof memoryRecord.$inferInsert)[];
}
export interface SearchRequest {
  organizationId: string;
  sources: readonly SourceMetadata[];
  records: readonly RecordMetadata[];
  text: string;
  vector: readonly number[];
  model: string;
  dimensions: number;
  mode: "full-text" | "semantic" | "hybrid" | "record";
  limit: number;
  now: Date;
}
export interface MemoryRepository {
  readonly metadata: (organizationId: string) => Promise<MemoryMetadata>;
  readonly source: (
    organizationId: string,
    sourceId: string
  ) => Promise<SourceMetadata | undefined>;
  readonly artifact: (
    organizationId: string,
    artifactId: string
  ) => Promise<ArtifactMetadata | undefined>;
  readonly search: (request: SearchRequest) => Promise<StoredRecord[]>;
  readonly publish: (
    binding: EffectBinding,
    input: Publication,
    upload?: () => Promise<void>
  ) => Promise<MutationResult>;
  readonly remember: (
    binding: EffectBinding,
    record: typeof memoryRecord.$inferInsert,
    dependencies: readonly SourceDependency[],
    generation: number
  ) => Promise<MutationResult>;
  readonly remove: (
    binding: EffectBinding,
    sourceId: string,
    state: "deleted" | "revoked"
  ) => Promise<MutationResult>;
  readonly registerArtifact: (
    binding: EffectBinding,
    artifact: typeof memoryArtifact.$inferInsert,
    generation: number,
    upload: () => Promise<void>
  ) => Promise<MutationResult>;
  readonly deleteArtifact: (
    binding: EffectBinding,
    artifactId: string
  ) => Promise<MutationResult>;
  readonly operationSource: (
    organizationId: string,
    operationId: string
  ) => Promise<{ sourceId: string; visibility: StoredVisibility } | undefined>;
  readonly cleanup: (
    deleteObject: (key: string) => Promise<void>,
    now?: Date
  ) => Promise<{ deleted: number; failed: number }>;
}

const conflict = (
  code: "digest-mismatch" | "version-mismatch" | "already-final",
  reason: string
): MutationResult => ({ code, reason, status: "conflict" });

const key = (organizationId: string, sourceId: string) =>
  and(
    eq(memorySource.organizationId, organizationId),
    eq(memorySource.id, sourceId)
  );

const invalidate = async (
  tx: MemoryTransaction,
  organizationId: string,
  sourceId: string,
  includeRoot: boolean
): Promise<number> => {
  const rows = await tx.execute<{
    id: string;
  }>(sql`with recursive affected(id) as (
      select ${sourceId}::text union select d.derived_source_id from memory_dependency d join affected a on d.source_id = a.id where d.organization_id = ${organizationId}
    ) select id from affected`);
  const ids = rows
    .map((row) => row.id)
    .filter((id) => includeRoot || id !== sourceId);
  if (ids.length === 0) {
    return 0;
  }
  const artifacts = await tx
    .select()
    .from(memoryArtifact)
    .where(
      and(
        eq(memoryArtifact.organizationId, organizationId),
        inArray(memoryArtifact.sourceId, ids)
      )
    );
  if (artifacts.length > 0) {
    await tx
      .insert(memoryArtifactDelete)
      .values(artifacts.map((artifact) => ({ objectKey: artifact.objectKey })))
      .onConflictDoUpdate({
        set: { readyAt: new Date() },
        target: memoryArtifactDelete.objectKey,
      });
  }
  await tx
    .delete(memoryArtifact)
    .where(
      and(
        eq(memoryArtifact.organizationId, organizationId),
        inArray(memoryArtifact.sourceId, ids)
      )
    );
  const records = await tx
    .delete(memoryRecord)
    .where(
      and(
        eq(memoryRecord.organizationId, organizationId),
        inArray(memoryRecord.sourceId, ids)
      )
    )
    .returning({ id: memoryRecord.id });
  await tx
    .update(memorySource)
    .set({
      generation: sql`${memorySource.generation} + 1`,
      state: "deleted",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(memorySource.organizationId, organizationId),
        inArray(memorySource.id, ids)
      )
    );
  await tx
    .delete(memoryDependency)
    .where(
      and(
        eq(memoryDependency.organizationId, organizationId),
        inArray(memoryDependency.derivedSourceId, ids)
      )
    );
  return records.length;
};

const decodeReceipt = (result: unknown): EffectReceipt | undefined => {
  if (
    !result ||
    typeof result !== "object" ||
    !("status" in result) ||
    result.status !== "ok" ||
    !("value" in result) ||
    !result.value ||
    typeof result.value !== "object"
  ) {
    return;
  }
  const { value } = result;
  return {
    ...("sourceId" in value && typeof value.sourceId === "string"
      ? { sourceId: value.sourceId }
      : {}),
    ...("recordId" in value && typeof value.recordId === "string"
      ? { recordId: value.recordId }
      : {}),
    ...("artifactId" in value && typeof value.artifactId === "string"
      ? { artifactId: value.artifactId }
      : {}),
    ...("removed" in value && typeof value.removed === "number"
      ? { removed: value.removed }
      : {}),
  };
};

export const createMemoryRepository = (
  database: Database
): MemoryRepository => {
  const effect = (
    binding: EffectBinding,
    run: (tx: MemoryTransaction) => Promise<MutationResult>
  ): Promise<MutationResult> =>
    database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${binding.id}, 0))`
      );
      const [prior] = await tx
        .select()
        .from(memoryOperation)
        .where(eq(memoryOperation.id, binding.id));
      if (prior) {
        if (
          prior.organizationId !== binding.organizationId ||
          prior.actorBinding !== binding.actorBinding ||
          prior.kind !== binding.kind ||
          prior.requestDigest !== binding.requestDigest ||
          prior.fingerprint !== binding.fingerprint
        ) {
          return conflict(
            "digest-mismatch",
            "The operation ID is bound to different arguments or an actor."
          );
        }
        const receipt = decodeReceipt(prior.result);
        if (receipt) {
          return { status: "ok", value: receipt };
        }
        return conflict(
          "already-final",
          "The operation has no recoverable result."
        );
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`memory:${binding.organizationId}`}, 0))`
      );
      const result = await run(tx);
      if (result.status === "ok") {
        await tx.insert(memoryOperation).values({ ...binding, result });
      }
      return result;
    });

  const operationExists = async (operationId: string): Promise<boolean> => {
    const [operation] = await database
      .select({ id: memoryOperation.id })
      .from(memoryOperation)
      .where(eq(memoryOperation.id, operationId));
    return !!operation;
  };

  return {
    async artifact(organizationId, artifactId) {
      const [artifact] = await database
        .select()
        .from(memoryArtifact)
        .where(
          and(
            eq(memoryArtifact.organizationId, organizationId),
            eq(memoryArtifact.id, artifactId)
          )
        );
      return artifact;
    },
    async cleanup(deleteObject, now = new Date()) {
      const pending = await database
        .select()
        .from(memoryArtifactDelete)
        .where(lte(memoryArtifactDelete.readyAt, now));
      const results = await Promise.all(
        pending.map(async (entry) => {
          try {
            await deleteObject(entry.objectKey);
            await database
              .delete(memoryArtifactDelete)
              .where(eq(memoryArtifactDelete.objectKey, entry.objectKey));
            return true;
          } catch (error) {
            await database
              .update(memoryArtifactDelete)
              .set({
                attempts: sql`${memoryArtifactDelete.attempts} + 1`,
                lastError:
                  error instanceof Error
                    ? error.message
                    : "Object deletion failed.",
              })
              .where(eq(memoryArtifactDelete.objectKey, entry.objectKey));
            return false;
          }
        })
      );
      return {
        deleted: results.filter(Boolean).length,
        failed: results.filter((result) => !result).length,
      };
    },
    deleteArtifact: (binding, artifactId) =>
      effect(binding, async (tx) => {
        const [artifact] = await tx
          .select()
          .from(memoryArtifact)
          .where(
            and(
              eq(memoryArtifact.organizationId, binding.organizationId),
              eq(memoryArtifact.id, artifactId)
            )
          );
        if (artifact) {
          await tx
            .insert(memoryArtifactDelete)
            .values({ objectKey: artifact.objectKey })
            .onConflictDoUpdate({
              set: { readyAt: new Date() },
              target: memoryArtifactDelete.objectKey,
            });
          await tx
            .delete(memoryArtifact)
            .where(
              and(
                eq(memoryArtifact.organizationId, binding.organizationId),
                eq(memoryArtifact.id, artifactId)
              )
            );
        }
        return {
          status: "ok",
          value: artifact
            ? {
                artifactId: artifact.id,
                sourceId: artifact.sourceId,
                visibility: artifact.visibility,
              }
            : {},
        };
      }),
    metadata: (organizationId) =>
      database.transaction(
        async (tx) => ({
          dependencies: await tx
            .select()
            .from(memoryDependency)
            .where(eq(memoryDependency.organizationId, organizationId)),
          records: await tx
            .select({
              id: memoryRecord.id,
              sourceId: memoryRecord.sourceId,
              sourceVersion: memoryRecord.sourceVersion,
              visibility: memoryRecord.visibility,
            })
            .from(memoryRecord)
            .where(eq(memoryRecord.organizationId, organizationId)),
          sources: await tx
            .select()
            .from(memorySource)
            .where(eq(memorySource.organizationId, organizationId)),
        }),
        { isolationLevel: "repeatable read" }
      ),
    async operationSource(organizationId, operationId) {
      const [operation] = await database
        .select()
        .from(memoryOperation)
        .where(
          and(
            eq(memoryOperation.organizationId, organizationId),
            eq(memoryOperation.id, operationId)
          )
        );
      const result = operation?.result;
      if (
        !result ||
        typeof result !== "object" ||
        !("value" in result) ||
        !result.value ||
        typeof result.value !== "object"
      ) {
        return;
      }
      const { value } = result;
      if (
        !("sourceId" in value) ||
        typeof value.sourceId !== "string" ||
        !("visibility" in value) ||
        !value.visibility ||
        typeof value.visibility !== "object" ||
        !("kind" in value.visibility)
      ) {
        return;
      }
      const { visibility } = value;
      if (visibility.kind === "organization") {
        return {
          sourceId: value.sourceId,
          visibility: { kind: "organization" },
        };
      }
      if (
        visibility.kind === "private" &&
        "ownerId" in visibility &&
        typeof visibility.ownerId === "string"
      ) {
        return {
          sourceId: value.sourceId,
          visibility: { kind: "private", ownerId: visibility.ownerId },
        };
      }
      if (
        visibility.kind === "grant" &&
        "grantId" in visibility &&
        typeof visibility.grantId === "string"
      ) {
        return {
          sourceId: value.sourceId,
          visibility: { grantId: visibility.grantId, kind: "grant" },
        };
      }
    },
    async publish(binding, input, upload) {
      if (input.originalArtifact && !(await operationExists(binding.id))) {
        await database
          .insert(memoryArtifactDelete)
          .values({
            objectKey: input.originalArtifact.objectKey,
            readyAt: new Date(Date.now() + 86_400_000),
          })
          .onConflictDoNothing();
      }
      return await effect(binding, async (tx) => {
        const [current] = await tx
          .select()
          .from(memorySource)
          .where(key(binding.organizationId, input.source.id));
        if (current && current.state !== "active") {
          return conflict(
            "already-final",
            "A source tombstone prevents ingestion."
          );
        }
        if (current?.version === input.source.version) {
          return current.fingerprint === input.source.fingerprint
            ? { status: "ok", value: { sourceId: current.id } }
            : conflict(
                "version-mismatch",
                "The same version has different content or metadata."
              );
        }
        if ((current?.generation ?? null) !== input.expectedGeneration) {
          return conflict(
            "version-mismatch",
            "The source changed before publication."
          );
        }
        if (current) {
          await invalidate(tx, binding.organizationId, current.id, false);
          const artifacts = await tx
            .select()
            .from(memoryArtifact)
            .where(
              and(
                eq(memoryArtifact.organizationId, binding.organizationId),
                eq(memoryArtifact.sourceId, current.id)
              )
            );
          if (artifacts.length > 0) {
            await tx
              .insert(memoryArtifactDelete)
              .values(
                artifacts.map((artifact) => ({ objectKey: artifact.objectKey }))
              )
              .onConflictDoNothing();
          }
          await tx
            .delete(memoryArtifact)
            .where(
              and(
                eq(memoryArtifact.organizationId, binding.organizationId),
                eq(memoryArtifact.sourceId, current.id)
              )
            );
          await tx
            .delete(memoryRecord)
            .where(
              and(
                eq(memoryRecord.organizationId, binding.organizationId),
                eq(memoryRecord.sourceId, current.id)
              )
            );
          await tx
            .delete(memoryDependency)
            .where(
              and(
                eq(memoryDependency.organizationId, binding.organizationId),
                eq(memoryDependency.derivedSourceId, current.id)
              )
            );
        }
        await tx
          .insert(memorySource)
          .values({
            ...input.source,
            generation: (current?.generation ?? 0) + 1,
          })
          .onConflictDoUpdate({
            set: {
              ...input.source,
              generation: (current?.generation ?? 0) + 1,
              updatedAt: new Date(),
            },
            target: [memorySource.organizationId, memorySource.id],
          });
        if (upload) {
          await upload();
        }
        if (input.records.length > 0) {
          await tx.insert(memoryRecord).values([...input.records]);
        }
        if (input.originalArtifact) {
          await tx.insert(memoryArtifact).values(input.originalArtifact);
          await tx
            .delete(memoryArtifactDelete)
            .where(
              eq(
                memoryArtifactDelete.objectKey,
                input.originalArtifact.objectKey
              )
            );
        }
        return {
          status: "ok",
          value: {
            artifactId: input.originalArtifact?.id,
            sourceId: input.source.id,
          },
        };
      });
    },
    async registerArtifact(binding, artifact, generation, upload) {
      if (!(await operationExists(binding.id))) {
        await database
          .insert(memoryArtifactDelete)
          .values({
            objectKey: artifact.objectKey,
            readyAt: new Date(Date.now() + 86_400_000),
          })
          .onConflictDoNothing();
      }
      return await effect(binding, async (tx) => {
        const [source] = await tx
          .select()
          .from(memorySource)
          .where(key(binding.organizationId, artifact.sourceId));
        if (
          !source ||
          source.state !== "active" ||
          source.generation !== generation ||
          source.version !== artifact.sourceVersion ||
          (source.expiresAt && source.expiresAt.getTime() <= Date.now())
        ) {
          return conflict(
            "version-mismatch",
            "The artifact provenance is no longer current."
          );
        }
        await upload();
        await tx.insert(memoryArtifact).values(artifact);
        await tx
          .delete(memoryArtifactDelete)
          .where(eq(memoryArtifactDelete.objectKey, artifact.objectKey));
        return {
          status: "ok",
          value: { artifactId: artifact.id, sourceId: artifact.sourceId },
        };
      });
    },
    remember: (binding, record, dependencies, generation) =>
      effect(binding, async (tx) => {
        const [source] = await tx
          .select()
          .from(memorySource)
          .where(key(binding.organizationId, record.sourceId));
        if (
          !source ||
          source.state !== "active" ||
          source.version !== record.sourceVersion ||
          source.generation !== generation ||
          (source.expiresAt && source.expiresAt.getTime() <= Date.now())
        ) {
          return conflict(
            "version-mismatch",
            "The provenance is no longer current."
          );
        }
        const validations = await Promise.all(
          dependencies.map(async (dependency) => {
            const [current] = await tx
              .select()
              .from(memorySource)
              .where(key(binding.organizationId, dependency.sourceId));
            if (
              !current ||
              current.state !== "active" ||
              current.version !== dependency.sourceVersion ||
              (current.expiresAt && current.expiresAt.getTime() <= Date.now())
            ) {
              return conflict(
                "version-mismatch",
                "A dependency is no longer current."
              );
            }
            const cycle = await tx.execute<{ id: string }>(
              sql`with recursive ancestors(id) as (select ${dependency.sourceId}::text union select d.source_id from memory_dependency d join ancestors a on d.derived_source_id = a.id where d.organization_id = ${binding.organizationId}) select id from ancestors where id = ${record.sourceId}`
            );
            if (cycle.length > 0) {
              return conflict(
                "version-mismatch",
                "A dependency cycle is not permitted."
              );
            }
          })
        );
        const failure = validations.find((result) => result !== undefined);
        if (failure) {
          return failure;
        }
        const [existing] = await tx
          .select({ id: memoryRecord.id })
          .from(memoryRecord)
          .where(
            and(
              eq(memoryRecord.organizationId, binding.organizationId),
              eq(memoryRecord.id, record.id)
            )
          );
        if (existing) {
          return conflict("already-final", "The record ID already exists.");
        }
        if (dependencies.length > 0) {
          await tx
            .insert(memoryDependency)
            .values([...dependencies])
            .onConflictDoNothing();
          await tx
            .update(memorySource)
            .set({
              generation: sql`${memorySource.generation} + 1`,
              updatedAt: new Date(),
            })
            .where(key(binding.organizationId, record.sourceId));
        }
        await tx.insert(memoryRecord).values(record);
        return {
          status: "ok",
          value: { recordId: record.id, sourceId: record.sourceId },
        };
      }),
    remove: (binding, sourceId, state) =>
      effect(binding, async (tx) => {
        const removed = await invalidate(
          tx,
          binding.organizationId,
          sourceId,
          true
        );
        await tx
          .insert(memorySource)
          .values({
            fingerprint: "",
            id: sourceId,
            observedAt: new Date(),
            organizationId: binding.organizationId,
            ownerId: binding.principalId,
            state,
            uri: "",
            version: "",
            visibility: { kind: "organization" },
          })
          .onConflictDoUpdate({
            set: { state, updatedAt: new Date() },
            target: [memorySource.organizationId, memorySource.id],
          });
        return { status: "ok", value: { removed } };
      }),
    async search(request) {
      if (request.sources.length === 0 || request.records.length === 0) {
        return [];
      }
      const sourceClauses = request.sources.map(
        (source) =>
          sql`(s.id = ${source.id} and s.version = ${source.version} and s.generation = ${source.generation})`
      );
      const recordClauses = request.records.map(
        (record) =>
          sql`(r.id = ${record.id} and r.source_id = ${record.sourceId} and r.source_version = ${record.sourceVersion} and r.visibility = ${JSON.stringify(record.visibility)}::jsonb)`
      );
      const dependencyClauses = request.sources.map(
        (source) =>
          sql`(ds.id = ${source.id} and ds.version = ${source.version} and ds.generation = ${source.generation})`
      );
      const embedding = `[${request.vector.join(",")}]`;
      const terms = sql`replace(plainto_tsquery('english', ${request.text})::text, ' & ', ' | ')::tsquery`;
      const fullText = sql`ts_rank_cd(r.search, ${terms})`;
      const semantic = sql`1 - (r.embedding <=> ${embedding}::vector)`;
      const scores = {
        "full-text": fullText,
        hybrid: sql`(${fullText} + ${semantic})`,
        record: sql`0::integer`,
        semantic,
      };
      const score = scores[request.mode];
      const modelMatch =
        request.mode === "full-text" || request.mode === "record"
          ? sql`true`
          : sql`r.embedding_model = ${request.model} and r.embedding_dimensions = ${request.dimensions}`;
      const match =
        request.mode === "full-text" ? sql`r.search @@ ${terms}` : sql`true`;
      const rows = await database.execute<{
        id: string;
        dependency_source_ids: string[];
        organization_id: string;
        source_id: string;
        source_version: string;
        source_uri: string;
        observed_at: Date;
        kind: StoredRecord["kind"];
        content: string;
        visibility: StoredVisibility;
        embedding: string;
        embedding_model: string;
        embedding_dimensions: number;
        created_at: Date;
        search: string;
      }>(sql`with authorized as materialized (
        select r.* from memory_record r join memory_source s on s.organization_id = r.organization_id and s.id = r.source_id
        where r.organization_id = ${request.organizationId} and (${sql.join(recordClauses, sql` or `)})
        and (${sql.join(sourceClauses, sql` or `)}) and r.source_version = s.version and s.state = 'active'
        and (s.expires_at is null or s.expires_at > ${request.now.toISOString()})
        and ${modelMatch}
        and not exists (select 1 from memory_dependency d left join memory_source ds on ds.organization_id = d.organization_id and ds.id = d.source_id where d.organization_id = s.organization_id and d.derived_source_id = s.id and (ds.id is null or not (${sql.join(dependencyClauses, sql` or `)}) or ds.state <> 'active' or ds.version <> d.source_version or (ds.expires_at is not null and ds.expires_at <= ${request.now.toISOString()})))
      ) select r.* from authorized r where ${match} order by ${score} desc, r.id asc limit ${request.limit}`);
      return rows.map((row) => ({
        content: row.content,
        createdAt: new Date(row.created_at),
        dependencySourceIds: row.dependency_source_ids,
        embedding: row.embedding.slice(1, -1).split(",").map(Number),
        embeddingDimensions: row.embedding_dimensions,
        embeddingModel: row.embedding_model,
        id: row.id,
        kind: row.kind,
        observedAt: new Date(row.observed_at),
        organizationId: row.organization_id,
        search: row.search,
        sourceId: row.source_id,
        sourceUri: row.source_uri,
        sourceVersion: row.source_version,
        visibility: row.visibility,
      }));
    },
    async source(organizationId, sourceId) {
      const [source] = await database
        .select()
        .from(memorySource)
        .where(key(organizationId, sourceId));
      return source;
    },
  };
};
