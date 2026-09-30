CREATE TABLE "cerebro_audit_event" (
	"agent_id" text NOT NULL,
	"event_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"organization_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_id" text NOT NULL,
	"session_id" text NOT NULL
);
