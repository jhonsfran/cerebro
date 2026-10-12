import {
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { organization } from "./core.ts";

// An MCP server an administrator added at runtime. Its tools live in
// connector_tool with source `admin:<id>`, its credentials in connector_account.
export const connector = pgTable(
  "connector",
  {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    id: text("id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    url: text("url").notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.id] })]
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
    source: text("source")
      .notNull()
      .$type<"runtime.json" | `mcp:${string}` | `admin:${string}`>(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.id] })]
);
export const connectorSchema = { connector, connectorTool };
