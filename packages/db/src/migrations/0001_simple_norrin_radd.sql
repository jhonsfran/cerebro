CREATE TABLE "scim_connection_binding" (
	"connection_id" text NOT NULL,
	"connection_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"decommission_batch_count" integer DEFAULT 0 NOT NULL,
	"decommission_completed_at" timestamp,
	"decommission_cursor_user_id" text,
	"decommission_lease_expires_at" timestamp,
	"decommission_lease_id" text,
	"decommission_reconciled_user_count" integer DEFAULT 0 NOT NULL,
	"decommission_revision" integer DEFAULT 0 NOT NULL,
	"decommission_status" text DEFAULT 'active' NOT NULL,
	"decommissioned_at" timestamp,
	"id" text PRIMARY KEY NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	CONSTRAINT "scim_connection_binding_connection_key_unique" UNIQUE("connection_key")
);
--> statement-breakpoint
CREATE TABLE "scim_group" (
	"connection_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"display_name" text NOT NULL,
	"display_name_key" text NOT NULL,
	"external_id" text,
	"external_id_key" text,
	"id" text PRIMARY KEY NOT NULL,
	"order_key" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "scim_group_display_name_key_unique" UNIQUE("display_name_key"),
	CONSTRAINT "scim_group_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_group_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
CREATE TABLE "scim_group_member" (
	"connection_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"group_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"membership_key" text NOT NULL,
	"scim_user_id" text NOT NULL,
	CONSTRAINT "scim_group_member_membership_key_unique" UNIQUE("membership_key")
);
--> statement-breakpoint
CREATE TABLE "scim_identity_tombstone" (
	"connection_id" text NOT NULL,
	"deleted_at" timestamp NOT NULL,
	"external_id" text NOT NULL,
	"external_id_key" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"profile" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "scim_identity_tombstone_external_id_key_unique" UNIQUE("external_id_key")
);
--> statement-breakpoint
CREATE TABLE "scim_projection_grant" (
	"connection_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"grant_key" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"role" text NOT NULL,
	"scim_user_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_value" text,
	"updated_at" timestamp NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "scim_projection_grant_grant_key_unique" UNIQUE("grant_key")
);
--> statement-breakpoint
CREATE TABLE "scim_subject" (
	"created_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"profile_source_id" text,
	"revision" integer NOT NULL,
	"updated_at" timestamp NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "scim_subject_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "scim_user" (
	"active" boolean NOT NULL,
	"connection_id" text NOT NULL,
	"connection_user_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"display_name" text NOT NULL,
	"email_value_index" text NOT NULL,
	"external_id" text,
	"external_id_key" text,
	"family_name" text,
	"formatted_name" text NOT NULL,
	"given_name" text,
	"id" text PRIMARY KEY NOT NULL,
	"order_key" text NOT NULL,
	"primary_email" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"serialized_attributes" text,
	"serialized_emails" text NOT NULL,
	"updated_at" timestamp NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"user_name_key" text NOT NULL,
	"work_email_value_index" text NOT NULL,
	CONSTRAINT "scim_user_connection_user_key_unique" UNIQUE("connection_user_key"),
	CONSTRAINT "scim_user_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_user_order_key_unique" UNIQUE("order_key"),
	CONSTRAINT "scim_user_user_name_key_unique" UNIQUE("user_name_key")
);
--> statement-breakpoint
CREATE TABLE "sso_provider" (
	"domain" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"organization_id" text,
	"provider_id" text NOT NULL,
	"saml_config" text,
	"user_id" text NOT NULL,
	CONSTRAINT "sso_provider_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE "identity_delegation" (
	"actor_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"represented_id" text NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "identity_delegation_scope" (
	"action" text NOT NULL,
	"delegation_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_kind" text NOT NULL,
	CONSTRAINT "identity_delegation_scope_delegation_id_action_resource_kind_resource_id_pk" PRIMARY KEY("delegation_id","action","resource_kind","resource_id")
);
--> statement-breakpoint
CREATE TABLE "identity_grant" (
	"action" text NOT NULL,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_kind" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "identity_grant_organization_id_principal_id_action_resource_kind_resource_id_source_pk" PRIMARY KEY("organization_id","principal_id","action","resource_kind","resource_id","source")
);
--> statement-breakpoint
CREATE TABLE "identity_policy_revision" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_principal" (
	"better_auth_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"directory_managed" boolean DEFAULT false NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"organization_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_role_permission" (
	"action" text NOT NULL,
	"organization_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"resource_kind" text NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "identity_role_permission_organization_id_role_id_action_resource_kind_resource_id_pk" PRIMARY KEY("organization_id","role_id","action","resource_kind","resource_id")
);
--> statement-breakpoint
CREATE TABLE "identity_slack_link" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"workspace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_slack_link_challenge" (
	"better_auth_user_id" text NOT NULL,
	"consumed_at" timestamp,
	"digest" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"principal_id" text NOT NULL,
	CONSTRAINT "identity_slack_link_challenge_digest_unique" UNIQUE("digest")
);
--> statement-breakpoint
ALTER TABLE "scim_group_member" ADD CONSTRAINT "scim_group_member_group_id_scim_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_member" ADD CONSTRAINT "scim_group_member_scim_user_id_scim_user_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_identity_tombstone" ADD CONSTRAINT "scim_identity_tombstone_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_projection_grant" ADD CONSTRAINT "scim_projection_grant_scim_user_id_scim_user_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_projection_grant" ADD CONSTRAINT "scim_projection_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_subject" ADD CONSTRAINT "scim_subject_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_user" ADD CONSTRAINT "scim_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_delegation" ADD CONSTRAINT "identity_delegation_actor_id_identity_principal_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."identity_principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_delegation" ADD CONSTRAINT "identity_delegation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_delegation" ADD CONSTRAINT "identity_delegation_represented_id_identity_principal_id_fk" FOREIGN KEY ("represented_id") REFERENCES "public"."identity_principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_delegation_scope" ADD CONSTRAINT "identity_delegation_scope_delegation_id_identity_delegation_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."identity_delegation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_grant" ADD CONSTRAINT "identity_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_grant" ADD CONSTRAINT "identity_grant_principal_id_identity_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."identity_principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_policy_revision" ADD CONSTRAINT "identity_policy_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_principal" ADD CONSTRAINT "identity_principal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_role_permission" ADD CONSTRAINT "identity_role_permission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_slack_link" ADD CONSTRAINT "identity_slack_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_slack_link" ADD CONSTRAINT "identity_slack_link_principal_id_identity_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."identity_principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_slack_link_challenge" ADD CONSTRAINT "identity_slack_link_challenge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_slack_link_challenge" ADD CONSTRAINT "identity_slack_link_challenge_principal_id_identity_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."identity_principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scimConnectionBinding_connectionId_idx" ON "scim_connection_binding" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimGroup_connectionId_idx" ON "scim_group" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimGroup_provisioningDomainId_idx" ON "scim_group" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scimGroupMember_connectionId_idx" ON "scim_group_member" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimGroupMember_groupId_idx" ON "scim_group_member" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "scimGroupMember_scimUserId_idx" ON "scim_group_member" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scimIdentityTombstone_connectionId_idx" ON "scim_identity_tombstone" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimIdentityTombstone_provisioningDomainId_idx" ON "scim_identity_tombstone" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scimIdentityTombstone_userId_idx" ON "scim_identity_tombstone" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scimProjectionGrant_connectionId_idx" ON "scim_projection_grant" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimProjectionGrant_provisioningDomainId_idx" ON "scim_projection_grant" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scimProjectionGrant_scimUserId_idx" ON "scim_projection_grant" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scimProjectionGrant_userId_idx" ON "scim_projection_grant" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scimSubject_profileSourceId_idx" ON "scim_subject" USING btree ("profile_source_id");--> statement-breakpoint
CREATE INDEX "scimUser_connectionId_idx" ON "scim_user" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scimUser_provisioningDomainId_idx" ON "scim_user" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scimUser_userId_idx" ON "scim_user" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "identity_delegation_actor_idx" ON "identity_delegation" USING btree ("organization_id","actor_id");--> statement-breakpoint
CREATE INDEX "identity_grant_principal_idx" ON "identity_grant" USING btree ("organization_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_principal_org_user_uq" ON "identity_principal" USING btree ("organization_id","better_auth_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_principal_org_id_uq" ON "identity_principal" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_slack_workspace_user_uq" ON "identity_slack_link" USING btree ("workspace_id","slack_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_slack_principal_workspace_uq" ON "identity_slack_link" USING btree ("organization_id","principal_id","workspace_id");--> statement-breakpoint
CREATE INDEX "identity_slack_challenge_principal_idx" ON "identity_slack_link_challenge" USING btree ("organization_id","principal_id");