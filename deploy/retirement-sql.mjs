export const schema = `CREATE TABLE IF NOT EXISTS cerebro_engine_retirement (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), phase TEXT NOT NULL, engine TEXT NOT NULL, fenced_at TIMESTAMPTZ NOT NULL DEFAULT now(), retired_at TIMESTAMPTZ);`;
export const legacyMetadata = `ALTER TABLE channel_conversation ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'legacy-v1'; ALTER TABLE channel_conversation ADD COLUMN IF NOT EXISTS retired_at TIMESTAMP;`;
export const retirementSql = `${schema}
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('cerebro-engine-retirement'));
INSERT INTO cerebro_engine_retirement(singleton, phase, engine) VALUES(TRUE, 'fenced', 'pi-v1') ON CONFLICT(singleton) DO NOTHING;
UPDATE channel_inbox i SET state='quarantined' FROM channel_conversation c WHERE i.conversation_id=c.conversation_id AND c.engine='legacy-v1' AND i.state IN ('pending','accepted');
UPDATE channel_reply r SET state='quarantined' FROM channel_conversation c WHERE r.conversation_id=c.conversation_id AND c.engine='legacy-v1' AND r.state IN ('ready','sending');
UPDATE channel_conversation SET retired_at=coalesce(retired_at, now()), projection_state='idle' WHERE engine='legacy-v1';
UPDATE cerebro_engine_retirement SET phase='retired', retired_at=coalesce(retired_at, now()) WHERE singleton;
COMMIT;
SELECT row_to_json(r) FROM cerebro_engine_retirement r WHERE singleton;`;
