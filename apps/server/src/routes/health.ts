import { createAuth } from "@cerebro/auth";
import { withDatabase } from "@cerebro/db";
import { createS3ObjectStorage } from "@cerebro/memory";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import type { WorkerEnv } from "../bindings";
import { runtimeConfiguration } from "../config";

const REQUIRED_TABLES = sql`select to_regclass('memory_record') AS memory, to_regclass('cerebro_audit_event') AS audit, to_regclass('agent_version') AS agent`;

const databaseReady = (env: WorkerEnv) =>
  withDatabase(env, async (database) => {
    try {
      createAuth(env, database);
    } catch {
      return false;
    }
    const [tables] = await database.execute(REQUIRED_TABLES);
    return Boolean(tables?.memory && tables.audit && tables.agent);
  });

const runtimeReady = async (env: WorkerEnv) => {
  const config = runtimeConfiguration(env);
  if (!env.SESSION || !env.AUDIT_SINK) {
    throw new Error("Runtime bindings are incomplete");
  }
  await createS3ObjectStorage(config.artifacts).ensureBucket({
    deadlineAt: Date.now() + 5000,
  });
  const audit = await env.AUDIT_SINK.fetch(
    new Request("https://audit.internal/ready")
  );
  if (!audit.ok) {
    throw new Error("Runtime graph is unavailable");
  }
};

export const healthRoutes = new Hono<{ Bindings: WorkerEnv }>()
  .get("/", (context) => context.text("OK"))
  .get("/health", (context) => context.json({ ok: true }))
  .get("/ready", async (context) => {
    try {
      if (!(await databaseReady(context.env))) {
        return context.json(
          { error: "Authentication configuration invalid", ok: false },
          503
        );
      }
      await runtimeReady(context.env);
      return context.json({ ok: true });
    } catch {
      return context.json(
        { error: "Runtime readiness checks failed", ok: false },
        503
      );
    }
  });
