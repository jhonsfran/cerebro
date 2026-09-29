import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// The pinned OpenCode migrator excludes these two exact table names. Keep
// Cerebro records in them until the coordinator updates the guarded patch.
export const sessionRows = sqliteTable("cerebro_session", {
  key: text("key").primaryKey(),
  sessionId: text("session_id").notNull(),
});

export const operationRows = sqliteTable("cerebro_operation", {
  id: text("id").primaryKey(),
  result: text("result", { mode: "json" }).$type<unknown>(),
});
