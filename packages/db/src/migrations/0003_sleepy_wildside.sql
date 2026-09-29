ALTER TABLE "channel_conversation" ADD COLUMN "stream_cursor" text;--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD COLUMN "projection_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD COLUMN "activity_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD COLUMN "last_projected_at" timestamp DEFAULT now() NOT NULL;