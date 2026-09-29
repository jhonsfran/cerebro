import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { DatabaseConfig } from "./config";
import { agentSchema } from "./schema/agents";
import { authSchema } from "./schema/auth";
import { organization } from "./schema/core";
import { identitySchema } from "./schema/identity";

const schema = {
  ...agentSchema,
  ...authSchema,
  ...identitySchema,
  organization,
};
const createDb = (client: ReturnType<typeof postgres>) =>
  drizzle(client, { schema });

export type Database = ReturnType<typeof createDb>;

export const withDatabase = async <T>(
  config: DatabaseConfig,
  run: (database: Database) => Promise<T>
): Promise<T> => {
  const client = postgres(config.DATABASE_URL, {
    connect_timeout: 5,
    idle_timeout: 1,
    max: 1,
    prepare: false,
  });
  try {
    return await run(createDb(client));
  } finally {
    await client.end({ timeout: 2 });
  }
};
