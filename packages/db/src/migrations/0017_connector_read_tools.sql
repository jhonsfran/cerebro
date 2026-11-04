ALTER TABLE "connector" ADD COLUMN "read_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;
