import { createAuth as createConfiguredAuth } from "@cerebro/auth";
import { withDatabase as withConfiguredDatabase } from "@cerebro/db";
import type { Database } from "@cerebro/db";

import type { WorkerEnv } from "./env.server";

export const withDatabase = <T>(
  env: WorkerEnv,
  run: (database: Database) => Promise<T>
): Promise<T> => withConfiguredDatabase(env, run);

export const createAuth = (env: WorkerEnv, database: Database) =>
  createConfiguredAuth(env, database);
