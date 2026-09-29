CREATE TABLE "connector" (
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"organization_id" text NOT NULL,
	"secret_reference" text NOT NULL,
	"state" text NOT NULL,
	"target_url" text NOT NULL,
	CONSTRAINT "connector_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "connector_kind" CHECK ("connector"."kind" IN ('mcp-read', 'fixture-write')),
	CONSTRAINT "connector_state" CHECK ("connector"."state" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "usage_account" (
	"available" bigint NOT NULL,
	"held" bigint DEFAULT 0 NOT NULL,
	"organization_id" text NOT NULL,
	"spent" bigint DEFAULT 0 NOT NULL,
	"total" bigint NOT NULL,
	"unit" text NOT NULL,
	CONSTRAINT "usage_account_organization_id_unit_pk" PRIMARY KEY("organization_id","unit"),
	CONSTRAINT "usage_account_balances" CHECK ("usage_account"."total" >= 0 AND "usage_account"."total" <= 9007199254740991 AND "usage_account"."available" >= 0 AND "usage_account"."held" >= 0 AND "usage_account"."spent" >= 0 AND "usage_account"."available" + "usage_account"."held" + "usage_account"."spent" = "usage_account"."total")
);
--> statement-breakpoint
CREATE TABLE "usage_operation" (
	"canonical_input" text NOT NULL,
	"digest" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_remote_operation" (
	"canonical_input" text NOT NULL,
	"claim_token" text,
	"claim_until" timestamp,
	"digest" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_reservation" (
	"id" text PRIMARY KEY NOT NULL,
	"incurred" bigint DEFAULT 0 NOT NULL,
	"maximum" bigint NOT NULL,
	"operation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"state" text NOT NULL,
	"unit" text NOT NULL,
	CONSTRAINT "usage_reservation_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "usage_reservation_amount" CHECK ("usage_reservation"."maximum" >= 0 AND "usage_reservation"."maximum" <= 9007199254740991 AND "usage_reservation"."incurred" >= 0 AND "usage_reservation"."incurred" <= "usage_reservation"."maximum")
);
--> statement-breakpoint
ALTER TABLE "connector" ADD CONSTRAINT "connector_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_account" ADD CONSTRAINT "usage_account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservation" ADD CONSTRAINT "usage_reservation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;