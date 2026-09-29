import { withDatabase } from "@cerebro/db";
import { projectAuditEvent } from "@cerebro/db/repositories/audit";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { TestEnvironment } from "./environment.ts";

export class AuditSink extends WorkerEntrypoint<TestEnvironment> {
  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/project"
    ) {
      return new Response(null, { status: 404 });
    }
    try {
      const event = (await request.json()) as Parameters<
        typeof projectAuditEvent
      >[1];
      await withDatabase(
        this.env,
        async (database) => await projectAuditEvent(database, event)
      );
      return Response.json({ ok: true });
    } catch {
      return Response.json(
        { error: "Projection unavailable" },
        { status: 503 }
      );
    }
  }
}
