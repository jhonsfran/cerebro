-- The old connector table was never read. Recreate it for connectors that
-- administrators add at runtime.
DROP TABLE IF EXISTS "connector" CASCADE;--> statement-breakpoint
CREATE TABLE "connector" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "connector_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "connector" ADD CONSTRAINT "connector_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;
