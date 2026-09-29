import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import { organization } from "./core.ts";

export const connector = pgTable(
  "connector",
  {
    id: text("id").notNull(),
    kind: text("kind").notNull().$type<"mcp-read" | "fixture-write">(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    secretReference: text("secret_reference").notNull(),
    state: text("state").notNull().$type<"active" | "disabled">(),
    targetUrl: text("target_url").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    check(
      "connector_kind",
      sql`${table.kind} IN ('mcp-read', 'fixture-write')`
    ),
    check("connector_state", sql`${table.state} IN ('active', 'disabled')`),
  ]
);
export const connectorSchema = { connector };
