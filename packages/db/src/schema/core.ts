import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const organization = pgTable("organization", {
  createdAt: timestamp("created_at").notNull().defaultNow(),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
