CREATE TABLE "connector_account" (
	"id" text NOT NULL,
	"label" text NOT NULL,
	"organization_id" text NOT NULL,
	"sealed" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "connector_account_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "connector_account" ADD CONSTRAINT "connector_account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;
