import { createDurableDb } from "@cerebro/db/durable";
import { eq, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

const fixtureSession = sqliteTable("cerebro_fixture_session", {
  key: text("key").primaryKey(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull(),
});

export class SessionFixture {
  private readonly database;

  constructor(state: DurableObjectState) {
    this.database = createDurableDb(state.storage);
    this.database.run(
      sql`CREATE TABLE IF NOT EXISTS cerebro_fixture_session (key TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL)`
    );
  }

  fetch(request: Request): Response {
    const userId = request.headers.get("X-Cerebro-Fixture-User-Id");
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const existing = this.database
      .select()
      .from(fixtureSession)
      .where(eq(fixtureSession.key, "session"))
      .get();
    if (request.method === "GET") {
      return existing?.userId === userId
        ? Response.json(existing)
        : Response.json({ error: "Not found" }, { status: 404 });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (existing && existing.userId !== userId) {
      return Response.json(
        { error: "Session already belongs to another user" },
        { status: 409 }
      );
    }
    if (existing) {
      return Response.json(existing);
    }
    const created = {
      key: "session",
      sessionId: crypto.randomUUID(),
      userId,
    };
    this.database.insert(fixtureSession).values(created).run();
    return Response.json(created, { status: 201 });
  }
}
