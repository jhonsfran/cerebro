ALTER TABLE "channel_conversation" ADD COLUMN IF NOT EXISTS "engine" text DEFAULT 'legacy-v1' NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_conversation" ADD COLUMN IF NOT EXISTS "retired_at" timestamp;
--> statement-breakpoint
ALTER TABLE "channel_inbox" ADD COLUMN IF NOT EXISTS "submission_mode" text DEFAULT 'follow-up' NOT NULL;
