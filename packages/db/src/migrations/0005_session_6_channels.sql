CREATE TABLE "agent" (
	"agent_id" text NOT NULL,
	"current_version" integer NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	CONSTRAINT "agent_organization_id_agent_id_pk" PRIMARY KEY("organization_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "agent_publish_operation" (
	"definition" jsonb NOT NULL,
	"digest" text NOT NULL,
	"operation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	CONSTRAINT "agent_publish_operation_organization_id_operation_id_pk" PRIMARY KEY("organization_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "agent_version" (
	"agent_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"organization_id" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "agent_version_organization_id_agent_id_version_pk" PRIMARY KEY("organization_id","agent_id","version")
);
--> statement-breakpoint
CREATE TABLE "channel_conversation" (
	"activity_version" integer DEFAULT 0 NOT NULL,
	"agent_id" text NOT NULL,
	"binding_key" text NOT NULL,
	"channel_id" text,
	"conversation_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"last_projected_at" timestamp DEFAULT now() NOT NULL,
	"organization_id" text NOT NULL,
	"owner_principal_id" text NOT NULL,
	"projection_state" text DEFAULT 'idle' NOT NULL,
	"root_timestamp" text,
	"session_id" text NOT NULL,
	"slack_user_id" text,
	"stream_cursor" text,
	"workspace_id" text,
	CONSTRAINT "channel_conversation_binding_key_unique" UNIQUE("binding_key")
);
--> statement-breakpoint
CREATE TABLE "channel_effect" (
	"digest" text NOT NULL,
	"operation_id" text PRIMARY KEY NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_fixture_run" (
	"agent_version" integer NOT NULL,
	"conversation_id" text NOT NULL,
	"digest" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"event_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	CONSTRAINT "channel_fixture_run_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "channel_fixture_run_operation_id_unique" UNIQUE("operation_id")
);
--> statement-breakpoint
CREATE TABLE "channel_inbox" (
	"conversation_id" text NOT NULL,
	"digest" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"event_key" text PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp DEFAULT now() NOT NULL,
	"organization_id" text NOT NULL,
	"receipt" jsonb,
	"state" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_item" (
	"conversation_id" text NOT NULL,
	"cursor" serial PRIMARY KEY NOT NULL,
	"item" jsonb NOT NULL,
	"item_key" text NOT NULL,
	"organization_id" text NOT NULL,
	CONSTRAINT "channel_item_item_key_unique" UNIQUE("item_key")
);
--> statement-breakpoint
CREATE TABLE "channel_link_event" (
	"digest" text NOT NULL,
	"event_key" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_reply" (
	"attempt_id" text,
	"conversation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"provider_receipt" jsonb,
	"reply_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"started_at" timestamp,
	"state" text NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "channel_reply_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "installation_setup" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"owner_principal_id" text NOT NULL,
	"owner_user_id" text NOT NULL
);
