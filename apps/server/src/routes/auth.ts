import { createAuth } from "@cerebro/auth";
import { withDatabase } from "@cerebro/db";
import { Hono } from "hono";

import type { WorkerEnv } from "../bindings";

export const authRoutes = new Hono<{ Bindings: WorkerEnv }>().on(
  ["POST", "GET", "PUT", "PATCH", "DELETE"],
  "/api/auth/*",
  (context) =>
    withDatabase(context.env, (database) =>
      createAuth(context.env, database).handler(context.req.raw)
    )
);
