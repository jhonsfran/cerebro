import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { organization } from "./core.ts";

export const usageAccount = pgTable(
  "usage_account",
  {
    available: bigint("available", { mode: "number" }).notNull(),
    held: bigint("held", { mode: "number" }).notNull().default(0),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    spent: bigint("spent", { mode: "number" }).notNull().default(0),
    total: bigint("total", { mode: "number" }).notNull(),
    unit: text("unit").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.unit] }),
    check(
      "usage_account_balances",
      sql`${table.total} >= 0 AND ${table.total} <= 9007199254740991 AND ${table.available} >= 0 AND ${table.held} >= 0 AND ${table.spent} >= 0 AND ${table.available} + ${table.held} + ${table.spent} = ${table.total}`
    ),
  ]
);

export const usageReservation = pgTable(
  "usage_reservation",
  {
    id: text("id").primaryKey(),
    incurred: bigint("incurred", { mode: "number" }).notNull().default(0),
    maximum: bigint("maximum", { mode: "number" }).notNull(),
    operationId: text("operation_id").notNull().unique(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    state: text("state", {
      enum: ["reserved", "settled", "released"],
    }).notNull(),
    unit: text("unit").notNull(),
  },
  (table) => [
    check(
      "usage_reservation_amount",
      sql`${table.maximum} >= 0 AND ${table.maximum} <= 9007199254740991 AND ${table.incurred} >= 0 AND ${table.incurred} <= ${table.maximum}`
    ),
  ]
);

export const usageOperation = pgTable("usage_operation", {
  canonicalInput: text("canonical_input").notNull(),
  digest: text("digest").notNull(),
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  result: jsonb("result").notNull(),
});

export const usageRemoteOperation = pgTable("usage_remote_operation", {
  canonicalInput: text("canonical_input").notNull(),
  claimToken: text("claim_token"),
  claimUntil: timestamp("claim_until"),
  digest: text("digest").notNull(),
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  state: jsonb("state").notNull(),
});

export const usageSchema = {
  usageAccount,
  usageOperation,
  usageRemoteOperation,
  usageReservation,
};
