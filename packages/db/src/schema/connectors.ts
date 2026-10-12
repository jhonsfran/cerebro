import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { organization } from "./core.ts";

export const connector = pgTable(
  "connector",
  {
    id: text("id").notNull(),
    kind: text("kind").notNull().$type<"mcp-read" | "http-write">(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    secretReference: text("secret_reference").notNull(),
    state: text("state").notNull().$type<"active" | "disabled">(),
    targetUrl: text("target_url").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    check("connector_kind", sql`${table.kind} IN ('mcp-read', 'http-write')`),
    check("connector_state", sql`${table.state} IN ('active', 'disabled')`),
  ]
);
// One tool an agent can enable. `definition` is the validated tool document;
// `source` names who replaces the row, so each source owns only its own tools.
export const connectorTool = pgTable(
  "connector_tool",
  {
    connectorId: text("connector_id").notNull(),
    definition: jsonb("definition").$type<unknown>().notNull(),
    id: text("id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    source: text("source").notNull().$type<"runtime.json" | `mcp:${string}`>(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.id] })]
);
export const connectorSchema = { connector, connectorTool };
