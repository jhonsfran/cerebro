import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { organization } from "./core.ts";

// One saved credential for an external service. `sealed` is AES-GCM ciphertext
// bound to the organization and account ID; the key never reaches the database.
export const connectorAccount = pgTable(
  "connector_account",
  {
    id: text("id").notNull(),
    label: text("label").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    sealed: text("sealed").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.id] })]
);
export const accountSchema = { connectorAccount };
