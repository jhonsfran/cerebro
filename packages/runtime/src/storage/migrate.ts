import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

import { sessionRows } from "./schema.ts";

export const CURRENT_LEDGER_VERSION = 2;

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
