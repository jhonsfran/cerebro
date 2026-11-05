CREATE TABLE "channel_conversation_operation" (
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"digest" text NOT NULL,
	"operation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"owner_principal_id" text NOT NULL,
	"session_id" text NOT NULL,
	CONSTRAINT "channel_conversation_operation_organization_id_owner_principal_id_operation_id_pk" PRIMARY KEY("organization_id","owner_principal_id","operation_id")
);
--> statement-breakpoint
ALTER TABLE "channel_conversation_operation" ADD CONSTRAINT "channel_conversation_operation_conversation_id_channel_conversation_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."channel_conversation"("conversation_id") ON DELETE no action ON UPDATE no action;