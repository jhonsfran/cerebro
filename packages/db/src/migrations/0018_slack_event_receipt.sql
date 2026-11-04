CREATE TABLE "channel_slack_event_receipt" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decision" jsonb NOT NULL,
	"digest" text NOT NULL,
	"event_key" text PRIMARY KEY NOT NULL
);
