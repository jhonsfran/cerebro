import { ChannelError } from "@cerebro/channels/types";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { assertWorkerEnv } from "./bindings";
import type { WorkerEnv } from "./bindings";
import { logRequest, requestRoute } from "./log";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";

export { AuditSink } from "./audit-sink";
export { IdentityAgent } from "./session/agent";
export { SessionAgent } from "./session/retired-agent";

const app = new Hono<{ Bindings: WorkerEnv }>();

const handleRequestError: Parameters<typeof app.onError>[0] = (
  error,
  context
) => {
  const forbidden = error instanceof ChannelError && error.status === 403;
  return context.json(
    {
      code: forbidden ? "forbidden" : "provider-unavailable",
      message: "The request could not complete.",
    },
    forbidden ? 403 : 503
  );
};
app.onError(handleRequestError);

app.use("*", async (context, proceed) => {
  const traceId = crypto.randomUUID();
  const started = performance.now();
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

app.use("*", async (context, proceed) => {
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
  })(context, proceed);
});

app.route("/", healthRoutes);
app.route("/", authRoutes);
app.route("/", apiRoutes);

export default app;
