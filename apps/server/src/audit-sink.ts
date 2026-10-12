import { withDatabase } from "@cerebro/db";
import {
  AuditProjectionConflictError,
  projectAuditEvent,
} from "@cerebro/db/repositories/audit";
import { WorkerEntrypoint } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { WorkerEnv } from "./bindings";

const auditSchema = z.strictObject({
  agentId: z.string(),
  eventId: z.string(),
  kind: z.literal("audit"),
  name: z.string(),
  occurredAt: z.number().finite(),
  organizationId: z.string(),
  payload: z.unknown(),
  runId: z.string(),
  sessionId: z.string(),
});

export class AuditSink extends WorkerEntrypoint<WorkerEnv> {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/ready") {
      await withDatabase(this.env, (database) =>
        database.execute(sql`select 1`)
      );
      return Response.json({ ok: true });
    }
    const event = auditSchema.parse(await request.json());
    try {
      await withDatabase(this.env, (database) =>
        projectAuditEvent(database, event)
      );
      return Response.json({ ok: true });
    } catch (error) {
      if (error instanceof AuditProjectionConflictError) {
        return Response.json(
          { code: "digest-mismatch", ok: false },
          { status: 409 }
        );
      }
      return Response.json(
        { code: "provider-unavailable", ok: false },
        { status: 503 }
      );
    }
  }
}
