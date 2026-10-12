import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { organization } from "./core.ts";

export const identityPrincipal = pgTable(
  "identity_principal",
  {
    betterAuthUserId: text("better_auth_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    directoryManaged: boolean("directory_managed").notNull().default(false),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["human", "service", "agent"] }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    state: text("state", { enum: ["active", "disabled"] })
      .notNull()
      .default("active"),
  },
  (table) => [
    uniqueIndex("identity_principal_org_user_uq").on(
      table.organizationId,
      table.betterAuthUserId
    ),
    uniqueIndex("identity_principal_org_id_uq").on(
      table.organizationId,
      table.id
    ),
  ]
);

export const identityGrant = pgTable(
  "identity_grant",
  {
    action: text("action", {
      enum: ["read", "execute", "write", "approve", "manage", "export"],
    }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    principalId: text("principal_id")
      .notNull()
      .references(() => identityPrincipal.id),
    resourceId: text("resource_id").notNull(),
    resourceKind: text("resource_kind", {
      enum: ["agent", "tool", "memory", "artifact", "audit"],
    }).notNull(),
    source: text("source").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.principalId,
        table.action,
        table.resourceKind,
        table.resourceId,
        table.source,
      ],
    }),
    index("identity_grant_principal_idx").on(
      table.organizationId,
      table.principalId
    ),
  ]
);

export const identityDelegation = pgTable(
  "identity_delegation",
  {
    actorId: text("actor_id")
      .notNull()
      .references(() => identityPrincipal.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    representedId: text("represented_id")
      .notNull()
      .references(() => identityPrincipal.id),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    index("identity_delegation_actor_idx").on(
      table.organizationId,
      table.actorId
    ),
  ]
);

export const identityDelegationScope = pgTable(
  "identity_delegation_scope",
  {
    action: text("action", {
      enum: ["read", "execute", "write", "approve", "manage", "export"],
    }).notNull(),
    delegationId: text("delegation_id")
      .notNull()
      .references(() => identityDelegation.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").notNull(),
    resourceKind: text("resource_kind", {
      enum: ["agent", "tool", "memory", "artifact", "audit"],
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.delegationId,
        table.action,
        table.resourceKind,
        table.resourceId,
      ],
    }),
  ]
);

export const identityRolePermission = pgTable(
  "identity_role_permission",
  {
    action: text("action", {
      enum: ["read", "execute", "write", "approve", "manage", "export"],
    }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    resourceId: text("resource_id").notNull(),
    resourceKind: text("resource_kind", {
      enum: ["agent", "tool", "memory", "artifact", "audit"],
    }).notNull(),
    roleId: text("role_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.roleId,
        table.action,
        table.resourceKind,
        table.resourceId,
      ],
    }),
  ]
);

export const identityPolicyRevision = pgTable("identity_policy_revision", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id),
  version: integer("version").notNull().default(1),
});

export const identitySlackLinkChallenge = pgTable(
  "identity_slack_link_challenge",
  {
    betterAuthUserId: text("better_auth_user_id").notNull(),
    consumedAt: timestamp("consumed_at"),
    digest: text("digest").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    principalId: text("principal_id")
      .notNull()
      .references(() => identityPrincipal.id),
  },
  (table) => [
    index("identity_slack_challenge_principal_idx").on(
      table.organizationId,
      table.principalId
    ),
  ]
);

export const identitySlackLink = pgTable(
  "identity_slack_link",
  {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    principalId: text("principal_id")
      .notNull()
      .references(() => identityPrincipal.id),
    slackUserId: text("slack_user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    uniqueIndex("identity_slack_workspace_user_uq").on(
      table.workspaceId,
      table.slackUserId
    ),
    uniqueIndex("identity_slack_principal_workspace_uq").on(
      table.organizationId,
      table.principalId,
      table.workspaceId
    ),
  ]
);

export const identitySchema = {
  identityDelegation,
  identityDelegationScope,
  identityGrant,
  identityPolicyRevision,
  identityPrincipal,
  identityRolePermission,
  identitySlackLink,
  identitySlackLinkChallenge,
};
