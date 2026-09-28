import { eq, TransactionRollbackError } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const user = pgTable("user", {
  createdAt: timestamp("created_at").notNull().defaultNow(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  id: text("id").primaryKey(),
  image: text("image"),
  name: text("name").notNull(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

const session = pgTable(
  "session",
  {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    id: text("id").primaryKey(),
    ipAddress: text("ip_address"),
    token: text("token").notNull().unique(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$onUpdate(() => new Date()),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)]
);

const account = pgTable(
  "account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    accountId: text("account_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$onUpdate(() => new Date()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("account_user_id_idx").on(table.userId)]
);

const verification = pgTable(
  "verification",
  {
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    value: text("value").notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

export const authSchema = { account, session, user, verification };

const probe = pgTable("slice_probe", {
  createdAt: timestamp("created_at").notNull().defaultNow(),
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

const createDatabase = (client: ReturnType<typeof postgres>) =>
  drizzle(client, { schema: authSchema });
export type Database = ReturnType<typeof createDatabase>;
export interface DatabaseProbe {
  committedKey: string;
  rolledBackKey: string;
  value: string;
}

export const withDatabase = async <T>(
  url: string,
  run: (db: Database) => Promise<T>
): Promise<T> => {
  const client = postgres(url, {
    connect_timeout: 5,
    idle_timeout: 1,
    max: 1,
    prepare: false,
  });
  try {
    return await run(createDatabase(client));
  } finally {
    await client.end({ timeout: 2 });
  }
};

export const probeDatabase = async (db: Database): Promise<DatabaseProbe> => {
  const marker = crypto.randomUUID();
  const committedKey = `commit-${marker}`;
  const rolledBackKey = `rollback-${marker}`;
  await db.transaction(async (tx) => {
    await tx.insert(probe).values({ key: committedKey, value: marker });
  });
  try {
    await db.transaction(async (tx) => {
      await tx.insert(probe).values({ key: rolledBackKey, value: marker });
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
  return { committedKey, rolledBackKey, value: marker };
};

export const readProbe = async (db: Database, key: string) => {
  const rows = await db.select().from(probe).where(eq(probe.key, key));
  return rows[0] ?? null;
};
