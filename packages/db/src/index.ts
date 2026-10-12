import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { DatabaseConfig } from "./config.ts";
import { accountSchema } from "./schema/accounts.ts";
import { agentSchema } from "./schema/agents.ts";
import { authSchema } from "./schema/auth.ts";
import { connectorSchema } from "./schema/connectors.ts";
import { organization } from "./schema/core.ts";
import { identitySchema } from "./schema/identity.ts";
import { memorySchema } from "./schema/memory.ts";

const schema = {
  ...accountSchema,
  ...agentSchema,
  ...authSchema,
  ...identitySchema,
  ...memorySchema,
  ...connectorSchema,
  organization,
};
const createDb = (client: ReturnType<typeof postgres>) =>
  drizzle(client, { schema });

export type Database = ReturnType<typeof createDb>;

export const withReservedDatabase = async <T>(
  database: Database,
  run: (connection: Database) => Promise<T>
): Promise<T> => {
  const connection = await database.$client.reserve();
  try {
    // postgres omits options on its reserved client; Drizzle reads the shared codecs.
    connection.options = database.$client.options;
    return await run(createDb(connection));
  } finally {
    connection.release();
  }
};

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
