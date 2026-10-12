import { createApiHandler } from "@cerebro/api/handler";
import type { BackgroundWork } from "@cerebro/api/handler";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import { createMemoryServices } from "../access";
import type { WorkerEnv } from "../bindings";
import { createChannelOptions } from "../channels";

interface Env {
  Bindings: WorkerEnv;
}

// Browser product calls must come from the configured web origin.
const sameOrigin: MiddlewareHandler<Env> = async (context, proceed) => {
  const origin = context.req.header("Origin");
  if (origin && origin !== context.env.CORS_ORIGIN) {
    return context.json(
      { code: "FORBIDDEN", message: "The request origin is not permitted." },
      403
    );
  }
  await proceed();
};

const noStore: MiddlewareHandler<Env> = async (context, proceed) => {
  await proceed();
  context.header("Cache-Control", "no-store");
};

const handlers = new WeakMap<WorkerEnv, ReturnType<typeof createApiHandler>>();
// The router is built once per isolate environment.
const api = (context: Context<Env>) => {
  let handler = handlers.get(context.env);
  if (!handler) {
    handler = createApiHandler(createChannelOptions(context.env), (database) =>
      createMemoryServices(context.env, database)
    );
    handlers.set(context.env, handler);
  }
  return handler(context.req.raw, backgroundWork(context));
};

// Hono throws when the host gives no ExecutionContext, as in some tests.
const backgroundWork = (context: Context<Env>) => {
  let background: BackgroundWork | undefined;
  try {
    background = context.executionCtx;
  } catch {
    // No background work is possible; the handler finishes before responding.
  }
  return background;
};

export const apiRoutes = new Hono<Env>()
  .use("/api/product/*", sameOrigin, noStore)
  .use("/api/channels/slack/*", noStore)
  .all("/api/product/*", api)
  .all("/api/channels/slack/*", api)
  .all("/rpc/*", api)
  .all("/api-reference", api)
  .all("/api-reference/*", api);
