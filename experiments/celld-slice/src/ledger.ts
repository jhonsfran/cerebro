import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

const sessions = sqliteTable("cerebro_session", {
  key: text("key").primaryKey(),
  sessionId: text("session_id").notNull(),
});
const operations = sqliteTable("cerebro_operation", {
  id: text("id").primaryKey(),
  result: text("result"),
});

export class Ledger {
  private readonly db;

  constructor(storage: DurableObjectStorage) {
    this.db = drizzle(storage);
    this.db.run(
      sql`CREATE TABLE IF NOT EXISTS cerebro_session (key TEXT PRIMARY KEY, session_id TEXT NOT NULL)`
    );
    this.db.run(
      sql`CREATE TABLE IF NOT EXISTS cerebro_operation (id TEXT PRIMARY KEY, result TEXT)`
    );
  }

  sessionId(): string | undefined {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.key, "opencode"))
      .get()?.sessionId;
  }

  saveSession(sessionId: string): void {
    this.db.insert(sessions).values({ key: "opencode", sessionId }).run();
  }

  operation(id: string) {
    return this.db.select().from(operations).where(eq(operations.id, id)).get();
  }

  start(id: string): void {
    this.db.insert(operations).values({ id }).run();
  }

  complete(id: string, result: string): void {
    this.db
      .update(operations)
      .set({ result })
      .where(eq(operations.id, id))
      .run();
  }
}
