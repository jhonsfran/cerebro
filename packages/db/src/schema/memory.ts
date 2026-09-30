import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  foreignKey,
} from "drizzle-orm/pg-core";

import { organization } from "./core.ts";
import { identityPrincipal } from "./identity.ts";

const embeddingVector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  fromDriver: (value) => value.slice(1, -1).split(",").map(Number),
  toDriver: (value) => `[${value.join(",")}]`,
});
const searchDocument = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export type MemorySourceState = "active" | "revoked" | "deleted";
export type StoredVisibility =
  | { kind: "private"; ownerId: string }
  | { kind: "organization" }
  | { kind: "grant"; grantId: string };

export const memorySource = pgTable(
  "memory_source",
  {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"),
    fingerprint: text("fingerprint").notNull(),
    generation: integer("generation").notNull().default(1),
    id: text("id").notNull(),
    observedAt: timestamp("observed_at").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    state: text("state", { enum: ["active", "revoked", "deleted"] }).notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    uri: text("uri").notNull(),
    version: text("version").notNull(),
    visibility: jsonb("visibility").$type<StoredVisibility>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.ownerId],
      foreignColumns: [identityPrincipal.organizationId, identityPrincipal.id],
    }),
  ]
);

export const memoryRecord = pgTable(
  "memory_record",
  {
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    dependencySourceIds: jsonb("dependency_source_ids")
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    embedding: embeddingVector("embedding"),
    embeddingDimensions: integer("embedding_dimensions"),
    embeddingModel: text("embedding_model"),
    id: text("id").notNull(),
    kind: text("kind", {
      enum: ["source-chunk", "conversation-summary", "remembered-fact"],
    }).notNull(),
    observedAt: timestamp("observed_at").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    search: searchDocument("search").generatedAlwaysAs(
      sql`to_tsvector('english', content)`
    ),
    sourceId: text("source_id").notNull(),
    sourceUri: text("source_uri").notNull(),
    sourceVersion: text("source_version").notNull(),
    visibility: jsonb("visibility").$type<StoredVisibility>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.sourceId],
      foreignColumns: [memorySource.organizationId, memorySource.id],
    }),
    index("memory_record_source_idx").on(table.organizationId, table.sourceId),
    index("memory_record_search_idx").using("gin", table.search),
  ]
);

export const memoryDependency = pgTable(
  "memory_dependency",
  {
    derivedSourceId: text("derived_source_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    sourceVersion: text("source_version").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.derivedSourceId, table.sourceId],
    }),
    foreignKey({
      columns: [table.organizationId, table.sourceId],
      foreignColumns: [memorySource.organizationId, memorySource.id],
    }),
    foreignKey({
      columns: [table.organizationId, table.derivedSourceId],
      foreignColumns: [memorySource.organizationId, memorySource.id],
    }),
  ]
);

export const memoryArtifact = pgTable(
  "memory_artifact",
  {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    fingerprint: text("fingerprint").notNull(),
    id: text("id").notNull(),
    objectKey: text("object_key").notNull().unique(),
    observedAt: timestamp("observed_at").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    sourceUri: text("source_uri").notNull(),
    sourceVersion: text("source_version").notNull(),
    visibility: jsonb("visibility").$type<StoredVisibility>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    foreignKey({
      columns: [table.organizationId, table.sourceId],
      foreignColumns: [memorySource.organizationId, memorySource.id],
    }),
  ]
);

export const memoryOperation = pgTable("memory_operation", {
  actorBinding: text("actor_binding").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  fingerprint: text("fingerprint").notNull(),
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  requestDigest: text("request_digest").notNull(),
  result: jsonb("result").$type<unknown>(),
});

export const memoryArtifactDelete = pgTable("memory_artifact_delete", {
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  objectKey: text("object_key").primaryKey(),
  readyAt: timestamp("ready_at").notNull().defaultNow(),
});

export const memorySchema = {
  memoryArtifact,
  memoryArtifactDelete,
  memoryDependency,
  memoryOperation,
  memoryRecord,
  memorySource,
};
