import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

import { sessionRows } from "./schema.ts";

export const CURRENT_LEDGER_VERSION = 3;

export const migrateLedger = (storage: DurableObjectStorage): void => {
  const db = drizzle(storage);
  storage.transactionSync(() => {
    db.run(
      sql`CREATE TABLE IF NOT EXISTS cerebro_session (key TEXT PRIMARY KEY, session_id TEXT NOT NULL)`
    );
    db.run(
      sql`CREATE TABLE IF NOT EXISTS cerebro_operation (id TEXT PRIMARY KEY, result TEXT)`
    );
    const row = db
      .select()
      .from(sessionRows)
      .where(eq(sessionRows.key, "schema-version"))
      .get();
    const version = row ? Number(row.sessionId) : 0;
    if (
      !Number.isInteger(version) ||
      version < 0 ||
      version > CURRENT_LEDGER_VERSION
    ) {
      throw new Error("Unsupported Cerebro ledger schema version");
    }
    if (version < 2) {
      db.run(
        sql`CREATE INDEX IF NOT EXISTS cerebro_operation_kind_idx ON cerebro_operation (id)`
      );
    }
    if (version < 3) {
      db.run(sql`ALTER TABLE cerebro_operation ADD COLUMN kind TEXT`);
      db.run(sql`ALTER TABLE cerebro_operation ADD COLUMN event_id TEXT`);
      db.run(sql`
        UPDATE cerebro_operation
        SET kind = CASE
          WHEN id LIKE 'approval-grant:%' THEN 'approval-grant'
          WHEN id LIKE 'approval-event:%' THEN 'approval-event'
          WHEN id LIKE 'identity:%' THEN 'identity'
          WHEN id LIKE 'inbox:%' THEN 'inbox'
          WHEN id LIKE 'submission:%' THEN 'submission'
          WHEN id LIKE 'decision:%' THEN 'decision'
          WHEN id LIKE 'run:%' THEN 'run'
          WHEN id LIKE 'invocation:%' THEN 'invocation'
          WHEN id LIKE 'approval:%' THEN 'approval'
          WHEN id LIKE 'control:%' THEN 'control'
          WHEN id LIKE 'cancellation:%' THEN 'cancellation'
          WHEN id LIKE 'stream:%' THEN 'stream'
          WHEN id LIKE 'outbox:%' THEN 'outbox'
          WHEN id LIKE 'usage:%' THEN 'usage'
          ELSE NULL
        END
        WHERE kind IS NULL AND json_valid(result)
      `);
      db.run(sql`
        UPDATE cerebro_operation
        SET event_id = json_extract(result, '$.eventId')
        WHERE kind = 'outbox' AND json_valid(result)
      `);
      db.run(sql`DROP INDEX IF EXISTS cerebro_operation_kind_idx`);
      db.run(
        sql`CREATE INDEX IF NOT EXISTS cerebro_operation_kind_idx ON cerebro_operation (kind, id)`
      );
      db.run(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS cerebro_outbox_event_idx ON cerebro_operation (event_id) WHERE kind = 'outbox'`
      );
    }
    db.insert(sessionRows)
      .values({
        key: "schema-version",
        sessionId: String(CURRENT_LEDGER_VERSION),
      })
      .onConflictDoUpdate({
        set: { sessionId: String(CURRENT_LEDGER_VERSION) },
        target: sessionRows.key,
      })
      .run();
  });
};
