import { createProductHandler } from "@cerebro/api/routers/conversations";
import { createAppRouter } from "@cerebro/api/routers/index";
import { ChannelError } from "@cerebro/channels/types";
import { createS3ObjectStorage } from "@cerebro/memory";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import { createChannelOptions } from "./channel-services";
import { createContext } from "./context";
import { assertWorkerEnv } from "./env.server";
import type { WorkerEnv } from "./env.server";
import { requestRoute, logRequest } from "./request-log";
import { createMemoryServices, runtimeConfiguration } from "./runtime-services";
import { createAuth, withDatabase } from "./services";

export { ChannelDispatcher } from "./channel-dispatcher";
export { SessionAgent } from "./deployed-session-agent";
export { TrustedGateway, AuditSink } from "./runtime-gateways";

const app = new Hono<{ Bindings: WorkerEnv }>();
const requestTraces = new WeakMap<Request, string>();
const handleRequestError: Parameters<typeof app.onError>[0] = (
  error,
  context
) =>
  context.json(
    {
      code:
        error instanceof ChannelError && error.status === 403
          ? "forbidden"
          : "provider-unavailable",
      message: "The request could not complete.",
    },
    error instanceof ChannelError && error.status === 403 ? 403 : 503
  );
app.onError(handleRequestError);
app.use("*", async (context, proceed) => {
  const traceId = crypto.randomUUID();
  const started = performance.now();
  requestTraces.set(context.req.raw, traceId);
  context.header("X-Cerebro-Trace-ID", traceId);
  await proceed();
  logRequest({
    durationMs: Math.round(performance.now() - started),
    method: context.req.method.slice(0, 16),
    route: requestRoute(context.req.path),
    status: context.res.status,
    traceId,
  });
});

app.use("*", async (context, next) => {
  try {
    assertWorkerEnv(context.env);
  } catch (error) {
    if (context.req.path === "/ready") {
      return context.json({ error: "Configuration invalid", ok: false }, 503);
    }
    throw error;
  }
  return await cors({
    allowHeaders: ["Content-Type", "Authorization", "Last-Event-ID"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    exposeHeaders: ["X-Cerebro-Trace-ID"],
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
      const tables = await database.execute(
        sql`select to_regclass('memory_record') AS memory, to_regclass('cerebro_audit_event') AS audit, to_regclass('agent_version') AS agent`
      );
      if (!tables[0]?.memory || !tables[0]?.audit || !tables[0]?.agent) {
        return false;
      }
      return true;
    });
    if (!authConfigured) {
      return context.json(
        { error: "Authentication configuration invalid", ok: false },
        503
      );
    }
    const config = runtimeConfiguration(context.env);
    if (
      !context.env.SESSION ||
      !context.env.LOADER ||
      !context.env.TOOL_GATEWAY ||
      !context.env.AUDIT_SINK ||
      !context.env.CHANNEL_DISPATCHER
    ) {
      throw new Error("Runtime bindings are incomplete");
    }
    await createS3ObjectStorage(config.artifacts).ensureBucket({
      deadlineAt: Date.now() + 5000,
    });
    const checks = await Promise.all([
      context.env.TOOL_GATEWAY.fetch(
        new Request("https://gateway.internal/ready")
      ),
      context.env.AUDIT_SINK.fetch(new Request("https://audit.internal/ready")),
    ]);
    if (checks.some((response) => !response.ok)) {
      throw new Error("Runtime graph is unavailable");
    }
    return context.json({ ok: true });
  } catch {
    return context.json(
      { error: "Runtime readiness checks failed", ok: false },
      503
    );
  }
});

app.on(["POST", "GET", "PUT", "PATCH", "DELETE"], "/api/auth/*", (context) =>
  withDatabase(context.env, (database) =>
    createAuth(context.env, database).handler(context.req.raw)
  )
);

app.use("*", async (context, next) => {
  const { path } = context.req;
  if (
    !path.startsWith("/api/product/") &&
    !path.startsWith("/api/channels/slack/")
  ) {
    return next();
  }
  const origin = context.req.header("Origin");
  if (
    path.startsWith("/api/product/") &&
    origin &&
    origin !== context.env.CORS_ORIGIN
  ) {
    return context.json(
      { code: "FORBIDDEN", message: "The request origin is not permitted." },
      403
    );
  }
  context.header("Cache-Control", "no-store");
  {
    const dispatcher = context.env.CHANNEL_DISPATCHER.get(
      context.env.CHANNEL_DISPATCHER.idFromName("installation")
    );
    const wake = await dispatcher.fetch(
      new Request("https://channel.internal/wake")
    );
    if (!wake.ok) {
      return context.json(
        { code: "UNAVAILABLE", message: "Channel recovery is unavailable." },
        503
      );
    }
  }
  const response = await createProductHandler(
    createChannelOptions(context.env)
  )(context.req.raw);
  if (
    response.ok &&
    context.req.method === "POST" &&
    /^\/api\/product\/conversations\/[^/]+\/messages$/u.test(path)
  ) {
    const result = z
      .object({
        cursor: z.string(),
        receipt: z.object({
          acceptedEventId: z.string(),
          replayed: z.boolean(),
          runId: z.string(),
          sessionId: z.string(),
        }),
      })
      .parse(await response.json());
    return context.json({
      ...result,
      receipt: {
        ...result.receipt,
        operationId: `submit:${result.receipt.acceptedEventId}`,
        traceId: requestTraces.get(context.req.raw),
      },
    });
  }
  return response;
});

app.use("/*", (context, next) => {
  const { path } = context.req;
  if (!path.startsWith("/rpc") && !path.startsWith("/api-reference")) {
    return next();
  }
  return withDatabase(context.env, async (database) => {
    const appRouter = createAppRouter((connection) =>
      createMemoryServices(context.env, connection)
    );
    const apiHandler = new OpenAPIHandler(appRouter, {
      plugins: [
        new OpenAPIReferencePlugin({
          schemaConverters: [new ZodToJsonSchemaConverter()],
        }),
      ],
    });
    const rpcHandler = new RPCHandler(appRouter);

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
