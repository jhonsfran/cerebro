CREATE TABLE "agent" (
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"current_version" integer NOT NULL,
	CONSTRAINT "agent_organization_id_agent_id_pk" PRIMARY KEY("organization_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "agent_publish_operation" (
	"organization_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"digest" text NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "agent_publish_operation_organization_id_operation_id_pk" PRIMARY KEY("organization_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "agent_version" (
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "agent_version_organization_id_agent_id_version_pk" PRIMARY KEY("organization_id","agent_id","version")
);
--> statement-breakpoint
CREATE TABLE "channel_conversation" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" text NOT NULL,
	"owner_principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"binding_key" text NOT NULL,
	"workspace_id" text,
	"slack_user_id" text,
	"channel_id" text,
	"root_timestamp" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "channel_conversation_binding_key_unique" UNIQUE("binding_key")
);
--> statement-breakpoint
CREATE TABLE "channel_effect" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_fixture_run" (
	"run_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"event_id" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"operation_id" text NOT NULL,
	"digest" text NOT NULL,
	"state" jsonb NOT NULL,
	"agent_version" integer NOT NULL,
	CONSTRAINT "channel_fixture_run_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "channel_fixture_run_operation_id_unique" UNIQUE("operation_id")
);
--> statement-breakpoint
CREATE TABLE "channel_inbox" (
	"event_key" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"digest" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"state" text NOT NULL,
	"receipt" jsonb
);
--> statement-breakpoint
CREATE TABLE "channel_item" (
	"cursor" serial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"item_key" text NOT NULL,
	"item" jsonb NOT NULL,
	CONSTRAINT "channel_item_item_key_unique" UNIQUE("item_key")
);
--> statement-breakpoint
CREATE TABLE "channel_link_event" (
	"event_key" text PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"principal_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_reply" (
	"reply_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"text" text NOT NULL,
	"state" text NOT NULL,
	"attempt_id" text,
	"started_at" timestamp,
	"provider_receipt" jsonb,
	CONSTRAINT "channel_reply_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "installation_setup" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_principal_id" text NOT NULL
);
