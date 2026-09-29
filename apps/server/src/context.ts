import type { Context as ApiContext } from "@cerebro/api/context";
import type { Database } from "@cerebro/db";
import type { Context as HonoContext } from "hono";

import type { WorkerEnv } from "./env.server";
import { createAuth } from "./services";

export interface CreateContextOptions {
  context: HonoContext<{ Bindings: WorkerEnv }>;
  database: Database;
}

export const createContext = async ({
  context,
  database,
}: CreateContextOptions): Promise<ApiContext> => {
  const session = await createAuth(context.env, database).api.getSession({
    headers: context.req.raw.headers,
  });
  return { db: database, session };
};
