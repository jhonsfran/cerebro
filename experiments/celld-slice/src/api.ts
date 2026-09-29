import { getAgentByName } from "agents";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";

import { createAuth } from "./auth";
import type { AuthSettings } from "./auth";
import { browserProbe } from "./browser-probe";
import { probeDatabase, readProbe, withDatabase } from "./database";
import type { Session } from "./session";
import { isFixtureCertificate, probePrivateCa } from "./tls-probe";
import { probeToolIsolation } from "./tool";
import type { ToolBindings } from "./tool";

export { MigrationControl } from "./migration-control";
export { OpenCodeControl } from "./opencode-control";
export { Session } from "./session";
export { RecoverySession } from "./recovery-session";
export { EffectGateway } from "./effect-tool";
export { FixtureGateway } from "./tool";

type SliceBindings = AuthSettings &
  ToolBindings & {
    DATABASE_URL: string;
    SESSION: DurableObjectNamespace<Session>;
    OPENCODE_CONTROL: DurableObjectNamespace;
    MIGRATION_CONTROL: DurableObjectNamespace;
    RECOVERY_SESSION: DurableObjectNamespace;
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

app.get("/browser", (c) => c.html(browserProbe));

app.get("/health", (c) => c.json({ ok: true }));

app.get("/database", async (c) => {
  const result = await withDatabase(c.env.DATABASE_URL, probeDatabase);
  return c.json({ ok: true, ...result });
});

app.post("/database/tls", bodyLimit({ maxSize: 8192 }), async (c) => {
  const certificate = await c.req.text();
  if (!isFixtureCertificate(certificate)) {
    return c.json({ error: "Invalid fixture certificate" }, 400);
  }
  return c.json(await probePrivateCa(certificate));
});

app.get("/database/read", async (c) => {
  const key = c.req.query("key");
  if (!key || key.length > 128) {
    return c.json({ error: "A probe key is required", ok: false }, 400);
  }
  try {
    const row = await withDatabase(c.env.DATABASE_URL, (db) =>
      readProbe(db, key)
    );
    return c.json({ ok: true, row });
  } catch {
    return c.json(
      { error: "Database read unavailable", ok: false, retryable: true },
      503
    );
  }
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
app.all("/recovery/:conversation/*", async (c) => {
  const session = c.env.RECOVERY_SESSION.get(
    c.env.RECOVERY_SESSION.idFromName(c.req.param("conversation"))
  );
  return await session.fetch(c.req.raw);
});
app.all("/sessions/:conversation/*", async (c) => {
  const durability = new URL(c.req.url).pathname.endsWith("/durability");
  try {
    const session = await getAgentByName(
      c.env.SESSION,
      JSON.stringify([
        "slice-company",
        "slice-agent",
        c.req.param("conversation"),
      ])
    );
    const response = await session.fetch(c.req.raw);
    if (!durability || response.status < 500) {
      return response;
    }
  } catch (error) {
    if (!durability) {
      throw error;
    }
  }
  return c.json(
    {
      error: "Durability unavailable",
      ok: false,
      outcome: "unknown",
      retryable: true,
    },
    503
  );
});

export default app;
