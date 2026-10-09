DROP TABLE "channel_fixture_run" CASCADE;--> statement-breakpoint
DROP TABLE "channel_inbox" CASCADE;--> statement-breakpoint
ALTER TABLE "connector" DROP CONSTRAINT "connector_kind";--> statement-breakpoint
UPDATE "connector" SET "kind" = 'http-write' WHERE "kind" = 'fixture-write';--> statement-breakpoint
ALTER TABLE "connector" ADD CONSTRAINT "connector_kind" CHECK ("connector"."kind" IN ('mcp-read', 'http-write'));
