import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const auditEvent = pgTable("cerebro_audit_event", {
  agentId: text("agent_id").notNull(),
  eventId: text("event_id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  occurredAt: timestamp("occurred_at", { mode: "date" }).notNull(),
  organizationId: text("organization_id").notNull(),
  payload: jsonb("payload").$type<unknown>().notNull(),
  runId: text("run_id").notNull(),
  sessionId: text("session_id").notNull(),
});
