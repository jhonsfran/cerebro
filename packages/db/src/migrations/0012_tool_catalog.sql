CREATE TABLE "connector_tool" (
	"connector_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "connector_tool_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "connector_tool" ADD CONSTRAINT "connector_tool_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Schema drift: earlier refactors stopped declaring these; nothing reads them.
DROP TABLE IF EXISTS "channel_item" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "channel_reply" CASCADE;--> statement-breakpoint
ALTER TABLE "channel_conversation" DROP COLUMN IF EXISTS "activity_version";--> statement-breakpoint
ALTER TABLE "channel_conversation" DROP COLUMN IF EXISTS "last_projected_at";--> statement-breakpoint
ALTER TABLE "channel_conversation" DROP COLUMN IF EXISTS "projection_state";--> statement-breakpoint
ALTER TABLE "channel_conversation" DROP COLUMN IF EXISTS "stream_cursor";
