import { appRouter } from "@cerebro/api/routers/index";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { createContext } from "./context";
import { assertWorkerEnv } from "./env.server";
import type { WorkerEnv } from "./env.server";
import { createAuth, withDatabase } from "./services";

export { SessionFixture } from "./session-fixture";

const app = new Hono<{ Bindings: WorkerEnv }>();

app.use("*", async (context, next) => {
  try {
    assertWorkerEnv(context.env);
  } catch (error) {
    if (context.req.path === "/ready") {
      return context.json({ error: "Configuration invalid", ok: false }, 503);
    }
    throw error;
  }
  await cors({
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    origin: context.env.CORS_ORIGIN,
  })(context, next);
});

app.get("/health", (context) => context.json({ ok: true }));
app.get("/ready", async (context) => {
  try {
    const authConfigured = await withDatabase(context.env, async (database) => {
      try {
        createAuth(context.env, database);
      } catch {
        return false;
      }
      await database.execute(sql`select 1`);
      return true;
    });
    if (!authConfigured) {
      return context.json(
        { error: "Authentication configuration invalid", ok: false },
        503
      );
    }
    return context.json({ ok: true });
  } catch {
    return context.json({ error: "Database unavailable", ok: false }, 503);
  }
});

app.on(["POST", "GET", "PUT", "PATCH", "DELETE"], "/api/auth/*", (context) =>
  withDatabase(context.env, (database) =>
    createAuth(context.env, database).handler(context.req.raw)
  )
);

app.on(["POST", "GET"], "/fixture/sessions/:name", (context) => {
  if (context.env.DEPLOY_MODE !== "fixture") {
    return context.json({ error: "Not found" }, 404);
  }
  return withDatabase(context.env, async (database) => {
    const auth = createAuth(context.env, database);
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
    });
    if (!session) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    const durable = context.env.SESSION_FIXTURE.get(
      context.env.SESSION_FIXTURE.idFromName(context.req.param("name"))
    );
    const request = new Request(context.req.raw.url, {
      headers: { "X-Cerebro-Fixture-User-Id": session.user.id },
      method: context.req.method,
    });
    return durable.fetch(request);
  });
});

const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
  ],
});
const rpcHandler = new RPCHandler(appRouter);

app.use("/*", (context, next) => {
  const { path } = context.req;
  if (!path.startsWith("/rpc") && !path.startsWith("/api-reference")) {
    return next();
  }
  return withDatabase(context.env, async (database) => {
    const apiContext = await createContext({ context, database });
    const handler = path.startsWith("/rpc") ? rpcHandler : apiHandler;
    const result = await handler.handle(context.req.raw, {
      context: apiContext,
      prefix: path.startsWith("/rpc") ? "/rpc" : "/api-reference",
    });
    if (result.matched) {
      return result.response;
    }
    return next();
  });
});

app.get("/", (context) => context.text("OK"));

export default app;
