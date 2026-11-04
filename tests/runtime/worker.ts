import { z } from "zod";

import type { TestEnvironment } from "./environment.ts";

export { AuditSink } from "./audit-sink.ts";
export { SessionAgent } from "./fixture-session.ts";
export { StorageConformance } from "./storage-fixture.ts";
export { TeamFixture } from "./fixture-team.ts";
export { CoordinatorFixture } from "./fixture-coordinator.ts";

const routingSchema = z
  .object({
    ownerPrincipalId: z.string().min(1).optional(),
    address: z.object({
      agentId: z.string().min(1),
      conversationId: z.string().min(1),
      organizationId: z.string().min(1),
      sessionId: z.string().min(1),
    }),
  })
  .passthrough();

export default {
  async fetch(request: Request, env: TestEnvironment): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return Response.json({ ok: true });
    }
    if (path.startsWith("/team/")) {
      const name = request.headers.get("x-team-name");
      if (!name) {
        return new Response(null, { status: 400 });
      }
      return await env.TEAM.get(env.TEAM.idFromName(name)).fetch(
        new Request(`https://team.internal/${path.slice(6)}`, request)
      );
    }
    if (path === "/conformance/storage" && request.method === "POST") {
      const namespace = env.STORAGE_CONFORMANCE;
      return await namespace
        .get(namespace.idFromName(crypto.randomUUID()))
        .fetch(request);
    }
    if (path === "/audit/replay" && request.method === "POST") {
      const body = await request.text();
      const statuses = await Promise.all(
        Array.from({ length: 2 }, async () => {
          const response = await env.AUDIT_SINK.fetch(
            new Request("https://audit.internal/project", {
              body,
              headers: { "Content-Type": "application/json" },
              method: "POST",
            })
          );
          return response.status;
        })
      );
      return Response.json({ statuses });
    }
    if (
      request.method !== "POST" ||
      (!path.startsWith("/runtime/") && !path.startsWith("/coord/"))
    ) {
      return new Response(null, { status: 404 });
    }
    const input = routingSchema.safeParse(await request.json());
    if (!input.success) {
      return Response.json(
        { error: "Invalid fixture address" },
        { status: 400 }
      );
    }
    const { address } = input.data;
    const name = JSON.stringify([
      address.organizationId,
      input.data.ownerPrincipalId ?? `user:${address.organizationId}`,
    ]);
    const namespace = path.startsWith("/coord/")
      ? env.COORDINATOR
      : env.SESSION;
    const session = namespace.get(namespace.idFromName(name));
    const prefix = path.startsWith("/coord/") ? "/coord/" : "/runtime/";
    return await session.fetch(
      new Request(`https://session.internal/${path.slice(prefix.length)}`, {
        body: JSON.stringify(input.data),
        headers: {
          "Content-Type": "application/json",
          "x-fixture-principal":
            request.headers.get("x-fixture-principal") ??
            input.data.ownerPrincipalId ??
            `user:${address.organizationId}`,
        },
        method: "POST",
      })
    );
  },
};
