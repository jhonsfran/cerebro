import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  createdAt: timestamp("created_at").notNull().defaultNow(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  id: text("id").primaryKey(),
  image: text("image"),
  name: text("name").notNull(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const session = pgTable(
  "session",
  {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    id: text("id").primaryKey(),
    ipAddress: text("ip_address"),
    token: text("token").notNull().unique(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$onUpdate(() => new Date()),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)]
);

export const account = pgTable(
  "account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    accountId: text("account_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$onUpdate(() => new Date()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("account_user_id_idx").on(table.userId)]
);

export const verification = pgTable(
  "verification",
  {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    value: text("value").notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

export const ssoProvider = pgTable("sso_provider", {
  domain: text("domain").notNull(),
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  organizationId: text("organization_id"),
  providerId: text("provider_id").notNull().unique(),
  samlConfig: text("saml_config"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const scimConnectionBinding = pgTable(
  "scim_connection_binding",
  {
    connectionId: text("connection_id").notNull(),
    connectionKey: text("connection_key").notNull().unique(),
    createdAt: timestamp("created_at").notNull(),
    decommissionBatchCount: integer("decommission_batch_count")
      .default(0)
      .notNull(),
    decommissionCompletedAt: timestamp("decommission_completed_at"),
    decommissionCursorUserId: text("decommission_cursor_user_id"),
    decommissionLeaseExpiresAt: timestamp("decommission_lease_expires_at"),
    decommissionLeaseId: text("decommission_lease_id"),
    decommissionReconciledUserCount: integer(
      "decommission_reconciled_user_count"
    )
      .default(0)
      .notNull(),
    decommissionRevision: integer("decommission_revision").default(0).notNull(),
    decommissionStatus: text("decommission_status").default("active").notNull(),
    decommissionedAt: timestamp("decommissioned_at"),
    id: text("id").primaryKey(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
  },
  (table) => [
    index("scimConnectionBinding_connectionId_idx").on(table.connectionId),
  ]
);

export const scimIdentityTombstone = pgTable(
  "scim_identity_tombstone",
  {
    connectionId: text("connection_id").notNull(),
    deletedAt: timestamp("deleted_at").notNull(),
    externalId: text("external_id").notNull(),
    externalIdKey: text("external_id_key").notNull().unique(),
    id: text("id").primaryKey(),
    profile: text("profile").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("scimIdentityTombstone_connectionId_idx").on(table.connectionId),
    index("scimIdentityTombstone_provisioningDomainId_idx").on(
      table.provisioningDomainId
    ),
    index("scimIdentityTombstone_userId_idx").on(table.userId),
  ]
);

export const scimSubject = pgTable(
  "scim_subject",
  {
    createdAt: timestamp("created_at").notNull(),
    id: text("id").primaryKey(),
    profileSourceId: text("profile_source_id"),
    revision: integer("revision").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("scimSubject_profileSourceId_idx").on(table.profileSourceId),
  ]
);

export const scimUser = pgTable(
  "scim_user",
  {
    active: boolean("active").notNull(),
    connectionId: text("connection_id").notNull(),
    connectionUserKey: text("connection_user_key").notNull().unique(),
    createdAt: timestamp("created_at").notNull(),
    displayName: text("display_name").notNull(),
    emailValueIndex: text("email_value_index").notNull(),
    externalId: text("external_id"),
    externalIdKey: text("external_id_key").unique(),
    familyName: text("family_name"),
    formattedName: text("formatted_name").notNull(),
    givenName: text("given_name"),
    id: text("id").primaryKey(),
    orderKey: text("order_key").notNull().unique(),
    primaryEmail: text("primary_email").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    serializedAttributes: text("serialized_attributes"),
    serializedEmails: text("serialized_emails").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    userName: text("user_name").notNull(),
    userNameKey: text("user_name_key").notNull().unique(),
    workEmailValueIndex: text("work_email_value_index").notNull(),
  },
  (table) => [
    index("scimUser_connectionId_idx").on(table.connectionId),
    index("scimUser_provisioningDomainId_idx").on(table.provisioningDomainId),
    index("scimUser_userId_idx").on(table.userId),
  ]
);

export const scimProjectionGrant = pgTable(
  "scim_projection_grant",
  {
    connectionId: text("connection_id").notNull(),
    createdAt: timestamp("created_at").notNull(),
    grantKey: text("grant_key").notNull().unique(),
    id: text("id").primaryKey(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    role: text("role").notNull(),
    scimUserId: text("scim_user_id")
      .notNull()
      .references(() => scimUser.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceValue: text("source_value"),
    updatedAt: timestamp("updated_at").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("scimProjectionGrant_connectionId_idx").on(table.connectionId),
    index("scimProjectionGrant_provisioningDomainId_idx").on(
      table.provisioningDomainId
    ),
    index("scimProjectionGrant_scimUserId_idx").on(table.scimUserId),
    index("scimProjectionGrant_userId_idx").on(table.userId),
  ]
);

export const scimGroup = pgTable(
  "scim_group",
  {
    connectionId: text("connection_id").notNull(),
    createdAt: timestamp("created_at").notNull(),
    displayName: text("display_name").notNull(),
    displayNameKey: text("display_name_key").notNull().unique(),
    externalId: text("external_id"),
    externalIdKey: text("external_id_key").unique(),
    id: text("id").primaryKey(),
    orderKey: text("order_key").notNull().unique(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    revision: integer("revision").default(0).notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("scimGroup_connectionId_idx").on(table.connectionId),
    index("scimGroup_provisioningDomainId_idx").on(table.provisioningDomainId),
  ]
);

export const scimGroupMember = pgTable(
  "scim_group_member",
  {
    connectionId: text("connection_id").notNull(),
    createdAt: timestamp("created_at").notNull(),
    groupId: text("group_id")
      .notNull()
      .references(() => scimGroup.id, { onDelete: "cascade" }),
    id: text("id").primaryKey(),
    membershipKey: text("membership_key").notNull().unique(),
    scimUserId: text("scim_user_id")
      .notNull()
      .references(() => scimUser.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("scimGroupMember_connectionId_idx").on(table.connectionId),
    index("scimGroupMember_groupId_idx").on(table.groupId),
    index("scimGroupMember_scimUserId_idx").on(table.scimUserId),
  ]
);

export const authSchema = {
  account,
  scimConnectionBinding,
  scimGroup,
  scimGroupMember,
  scimIdentityTombstone,
  scimProjectionGrant,
  scimSubject,
  scimUser,
  session,
  ssoProvider,
  user,
  verification,
};
