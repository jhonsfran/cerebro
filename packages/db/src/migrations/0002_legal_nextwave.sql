CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "memory_artifact" (
	"organization_id" text NOT NULL,
	"id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_version" text NOT NULL,
	"source_uri" text NOT NULL,
	"observed_at" timestamp NOT NULL,
	"object_key" text NOT NULL,
	"visibility" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memory_artifact_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "memory_artifact_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "memory_artifact_delete" (
	"object_key" text PRIMARY KEY NOT NULL,
	"ready_at" timestamp DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "memory_dependency" (
	"organization_id" text NOT NULL,
	"derived_source_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_version" text NOT NULL,
	CONSTRAINT "memory_dependency_organization_id_derived_source_id_source_id_pk" PRIMARY KEY("organization_id","derived_source_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "memory_operation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_binding" text NOT NULL,
	"kind" text NOT NULL,
	"request_digest" text NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_record" (
	"organization_id" text NOT NULL,
	"id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_version" text NOT NULL,
	"source_uri" text NOT NULL,
	"observed_at" timestamp NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"visibility" jsonb NOT NULL,
	"embedding" vector NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dimensions" integer NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memory_record_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "memory_source" (
	"organization_id" text NOT NULL,
	"id" text NOT NULL,
	"state" text NOT NULL,
	"version" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"fingerprint" text NOT NULL,
	"uri" text NOT NULL,
	"visibility" jsonb NOT NULL,
	"owner_id" text NOT NULL,
	"observed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	CONSTRAINT "memory_source_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "memory_artifact" ADD CONSTRAINT "memory_artifact_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_artifact" ADD CONSTRAINT "memory_artifact_organization_id_source_id_memory_source_organization_id_id_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "public"."memory_source"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_dependency" ADD CONSTRAINT "memory_dependency_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_dependency" ADD CONSTRAINT "memory_dependency_organization_id_source_id_memory_source_organization_id_id_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "public"."memory_source"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_dependency" ADD CONSTRAINT "memory_dependency_organization_id_derived_source_id_memory_source_organization_id_id_fk" FOREIGN KEY ("organization_id","derived_source_id") REFERENCES "public"."memory_source"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_operation" ADD CONSTRAINT "memory_operation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_record" ADD CONSTRAINT "memory_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_record" ADD CONSTRAINT "memory_record_organization_id_source_id_memory_source_organization_id_id_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "public"."memory_source"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_source" ADD CONSTRAINT "memory_source_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_source" ADD CONSTRAINT "memory_source_organization_id_owner_id_identity_principal_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_id") REFERENCES "public"."identity_principal"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_record_source_idx" ON "memory_record" USING btree ("organization_id","source_id");--> statement-breakpoint
CREATE INDEX "memory_record_search_idx" ON "memory_record" USING gin ("search");