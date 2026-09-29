import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { LedgerKind, LedgerValue } from "../ledger-records.ts";

// The pinned OpenCode migrator excludes these two exact table names. Keep
// Cerebro records in them until the coordinator updates the guarded patch.
export const sessionRows = sqliteTable("cerebro_session", {
  key: text("key").primaryKey(),
  sessionId: text("session_id").notNull(),
});

export const operationRows = sqliteTable("cerebro_operation", {
  eventId: text("event_id"),
  id: text("id").primaryKey(),
  kind: text("kind").$type<LedgerKind>(),
  result: text("result", { mode: "json" }).$type<LedgerValue>(),
});
