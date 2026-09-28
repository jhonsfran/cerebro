import { getAgentByName } from "agents";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { createAuth } from "./auth";
import type { AuthSettings } from "./auth";
import { probeDatabase, readProbe, withDatabase } from "./database";
import type { Session } from "./session";
import { probeToolIsolation } from "./tool";
import type { ToolBindings } from "./tool";

export { MigrationControl } from "./migration-control";
export { OpenCodeControl } from "./opencode-control";
export { Session } from "./session";
export { FixtureGateway } from "./tool";

type SliceBindings = AuthSettings &
  ToolBindings & {
    DATABASE_URL: string;
    SESSION: DurableObjectNamespace<Session>;
    OPENCODE_CONTROL: DurableObjectNamespace;
    MIGRATION_CONTROL: DurableObjectNamespace;
  };
const app = new Hono<{ Bindings: SliceBindings }>();
const connectionPattern = /postgres(?:ql)?:\/\/[^\s"']+/giu;

app.use(
  "*",
  async (c, next) =>
    await cors({
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      credentials: true,
      origin: c.env.AUTH_URL,
    })(c, next)
);

app.onError((failure, c) =>
  c.json(
    {
      error: {
        message: failure.message
          .replace(connectionPattern, "[database URL removed]")
          .replaceAll(c.env.AUTH_SECRET, "[secret removed]"),
        name: failure.name,
      },
      ok: false,
    },
    500
  )
);

app.get("/health", (c) => c.json({ ok: true }));

app.get("/database", async (c) => {
  const result = await withDatabase(c.env.DATABASE_URL, probeDatabase);
  return c.json({ ok: true, ...result });
});

app.get("/database/read", async (c) => {
  const key = c.req.query("key");
  if (!key || key.length > 128) {
    return c.json({ error: "A probe key is required", ok: false }, 400);
  }
  const row = await withDatabase(c.env.DATABASE_URL, (db) =>
    readProbe(db, key)
  );
  return c.json({ ok: true, row });
});

app.on(
  ["GET", "POST"],
  "/api/auth/*",
  async (c) =>
    await withDatabase(
      c.env.DATABASE_URL,
      async (db) => await createAuth(db, c.env).handler(c.req.raw)
    )
);

app.get("/private", async (c) => {
  const session = await withDatabase(
    c.env.DATABASE_URL,
    async (db) =>
      await createAuth(db, c.env).api.getSession({
        headers: c.req.raw.headers,
      })
  );
  if (!session) {
    return c.json({ error: "Unauthorized", ok: false }, 401);
  }
  return c.json({ ok: true, user: session.user });
});

app.all(
  "/control/migration/:name/*",
  async (c) =>
    await c.env.MIGRATION_CONTROL.get(
      c.env.MIGRATION_CONTROL.idFromName(c.req.param("name"))
    ).fetch(c.req.raw)
);
app.get(
  "/control/opencode/:name",
  async (c) =>
    await c.env.OPENCODE_CONTROL.get(
      c.env.OPENCODE_CONTROL.idFromName(c.req.param("name"))
    ).fetch(c.req.raw)
);
app.get("/tools/isolation", async (c) =>
  c.json(await probeToolIsolation(c.env))
);
app.all("/sessions/:conversation/*", async (c) => {
  const session = await getAgentByName(
    c.env.SESSION,
    JSON.stringify([
      "slice-company",
      "slice-agent",
      c.req.param("conversation"),
    ])
  );
  return await session.fetch(c.req.raw);
});

export default app;
