import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { organization } from "./core.ts";

// Instructions an agent can activate by name when a task matches them.
export const skill = pgTable(
  "skill",
  {
    body: text("body").notNull(),
    description: text("description").notNull(),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.name] })]
);
export const skillSchema = { skill };
