DROP TABLE "usage_account" CASCADE;--> statement-breakpoint
DROP TABLE "usage_operation" CASCADE;--> statement-breakpoint
DROP TABLE "usage_remote_operation" CASCADE;--> statement-breakpoint
DROP TABLE "usage_reservation" CASCADE;--> statement-breakpoint
DELETE FROM "identity_grant" WHERE "resource_kind" = 'budget';--> statement-breakpoint
DELETE FROM "identity_delegation_scope" WHERE "resource_kind" = 'budget';--> statement-breakpoint
DELETE FROM "identity_role_permission" WHERE "resource_kind" = 'budget';