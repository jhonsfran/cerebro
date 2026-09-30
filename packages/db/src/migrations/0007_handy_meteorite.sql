ALTER TABLE "memory_record" ALTER COLUMN "embedding" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_record" ALTER COLUMN "embedding_dimensions" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_record" ALTER COLUMN "embedding_model" DROP NOT NULL;