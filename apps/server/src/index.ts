import { createProductHandler } from "@cerebro/api/routers/conversations";
import { createAppRouter } from "@cerebro/api/routers/index";
import { principalContext } from "@cerebro/channels/security";
import { ChannelError } from "@cerebro/channels/types";
import { id } from "@cerebro/contracts";
import { auditEvent } from "@cerebro/db/schema/audit";
import { createS3ObjectStorage } from "@cerebro/memory";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { getAgentByName } from "agents";
import { and, count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import { createChannelOptions } from "./channel-services";
import { createContext } from "./context";
import { assertWorkerEnv } from "./env.server";
import type { WorkerEnv } from "./env.server";
import { requestRoute, logRequest } from "./request-log";
import {
  createCurrentAuthorization,
  createMemoryServices,
  runtimeConfiguration,
} from "./runtime-services";
import { createAuth, withDatabase } from "./services";

export { ChannelDispatcher } from "./channel-dispatcher";
export { SessionFixture } from "./session-fixture";
export { SessionAgent } from "./deployed-session-agent";
export { GatewayJournal, TrustedGateway, AuditSink } from "./runtime-gateways";

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
      !context.env.GATEWAY_JOURNAL ||
      !context.env.AUDIT_SINK ||
      !context.env.CHANNEL_DISPATCHER
    ) {
      throw new Error("Runtime bindings are incomplete");
    }
    await createS3ObjectStorage(config.artifacts).ensureBucket({
      deadlineAt: Date.now() + 5000,
    });
    const session = await getAgentByName(context.env.SESSION, "readiness");
    const checks = await Promise.all([
      session.fetch(new Request("https://session.internal/ready")),
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

app.post("/api/fixture/runtime/isolation", (context) => {
  if (context.env.DEPLOY_MODE !== "fixture") {
    return context.json({ error: "Not found" }, 404);
  }
  return withDatabase(context.env, async (database) => {
    const session = await createAuth(context.env, database).api.getSession({
      headers: context.req.raw.headers,
    });
    if (!session) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    const organizationId =
      context.env.CHANNEL_ORGANIZATION_ID ?? "local-company";
    const execution = await principalContext(
      database,
      organizationId,
      session.user.id
    );
    const allowed = await createCurrentAuthorization(context.env).evaluate(
      execution,
      "manage",
      {
        id: `installation:${organizationId}`,
        kind: "agent",
        organizationId: id.organization(organizationId),
      },
      { deadlineAt: Date.now() + 5000 }
    );
    if (allowed.status !== "ok") {
      return context.json({ error: "Authorization unavailable" }, 503);
    }
    if (allowed.value.decision !== "allow") {
      return context.json({ error: "Forbidden" }, 403);
    }
    const worker = context.env.LOADER.get("cerebro-isolation-proof-v1", () => ({
      compatibilityDate: "2026-09-28",
      env: { GATEWAY: context.env.TOOL_GATEWAY },
      globalOutbound: null,
      mainModule: "isolation.js",
      modules: {
        "isolation.js": `export default {async fetch(request, env){let deniedAmbientEgress=false;try{await fetch("http://fixture:8090/health")}catch{deniedAmbientEgress=true}const gateway=await env.GATEWAY.fetch(new Request("https://gateway.internal/ready"));return Response.json({deniedAmbientEgress,gatewayReachable:gateway.ok})}}`,
      },
    }));
    return await worker
      .getEntrypoint()
      .fetch(new Request("https://isolation.internal/probe"));
  });
});

const auditReplayInput = z.strictObject({
  changed: z.boolean().default(false),
  eventId: z.string().min(1).max(512),
});
app.post("/api/fixture/audit/replay", (context) => {
  if (context.env.DEPLOY_MODE !== "fixture") {
    return context.json({ error: "Not found" }, 404);
  }
  const origin = context.req.header("Origin");
  if (origin && origin !== context.env.CORS_ORIGIN) {
    return context.json({ error: "Forbidden" }, 403);
  }
  return withDatabase(context.env, async (database) => {
    const session = await createAuth(context.env, database).api.getSession({
      headers: context.req.raw.headers,
    });
    if (!session) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    const organizationId =
      context.env.CHANNEL_ORGANIZATION_ID ?? "local-company";
    const execution = await principalContext(
      database,
      organizationId,
      session.user.id
    );
    const allowed = await createCurrentAuthorization(context.env).evaluate(
      execution,
      "manage",
      {
        id: `installation:${organizationId}`,
        kind: "agent",
        organizationId: id.organization(organizationId),
      },
      { deadlineAt: Date.now() + 5000 }
    );
    if (allowed.status !== "ok") {
      return context.json({ error: "Authorization unavailable" }, 503);
    }
    if (allowed.value.decision !== "allow") {
      return context.json({ error: "Forbidden" }, 403);
    }
    const input = auditReplayInput.safeParse(await context.req.json());
    if (!input.success) {
      return context.json({ error: "Invalid replay input" }, 400);
    }
    const scope = and(
      eq(auditEvent.eventId, input.data.eventId),
      eq(auditEvent.organizationId, organizationId)
    );
    const [row] = await database.select().from(auditEvent).where(scope);
    if (!row) {
      return context.json({ error: "Not found" }, 404);
    }
    const [before] = await database
      .select({ count: count() })
      .from(auditEvent)
      .where(scope);
    const event = {
      ...row,
      name: input.data.changed ? `${row.name}.replay-conflict` : row.name,
      occurredAt: row.occurredAt.getTime(),
    };
    const statuses = await Promise.all(
      [1, 2].map(async () => {
        const response = await context.env.AUDIT_SINK.fetch(
          new Request("https://audit.internal/project", {
            body: JSON.stringify(event),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          })
        );
        return response.status;
      })
    );
    const [after] = await database
      .select({ count: count() })
      .from(auditEvent)
      .where(scope);
    const result = {
      after: after?.count ?? 0,
      before: before?.count ?? 0,
      statuses,
    };
    if (statuses.includes(409)) {
      return context.json(result, 409);
    }
    if (statuses.some((status) => status !== 200)) {
      return context.json(result, 503);
    }
    return context.json(result);
  });
});

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

app.use("*", async (context, next) => {
  const { path } = context.req;
  if (
    !path.startsWith("/api/product/") &&
    !path.startsWith("/api/channels/slack/") &&
    !path.startsWith("/api/fixture/slack/")
  ) {
    return next();
  }
  const origin = context.req.header("Origin");
  if (
    (path.startsWith("/api/product/") || path.startsWith("/api/fixture/")) &&
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
