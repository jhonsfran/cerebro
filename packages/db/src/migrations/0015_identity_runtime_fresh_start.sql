UPDATE "channel_conversation"
SET "retired_at" = COALESCE("retired_at", CURRENT_TIMESTAMP)
WHERE "engine" IN ('legacy-v1', 'pi-v1');
