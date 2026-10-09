import { z } from "zod";

import type { TestEnvironment } from "./environment.ts";

export { AuditSink } from "./audit-sink.ts";
export { FixtureEffectGateway } from "./fixture-gateway.ts";
export { SessionAgent } from "./fixture-session.ts";

const routingSchema = z
  .object({
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
    // A loaded Worker without global outbound must fail to reach the provider
    // directly while its named gateway binding still works.
    if (path === "/isolation" && request.method === "POST") {
      const probe = env.LOADER.get("runtime-isolation-probe-v1", () => ({
        compatibilityDate: "2026-09-28",
        env: { GATEWAY: env.TOOL_GATEWAY },
        globalOutbound: null,
        mainModule: "probe.js",
        modules: {
          "probe.js": `export default { async fetch(request, env) {
            let deniedAmbientEgress = false;
            try { await fetch("${env.FIXTURE_URL}/health"); } catch { deniedAmbientEgress = true; }
            const gateway = await env.GATEWAY.fetch(new Request("https://gateway.internal/health"));
            return Response.json({ deniedAmbientEgress, gatewayReachable: gateway.ok });
          } };`,
        },
      }));
      return await probe
        .getEntrypoint()
        .fetch(new Request("https://isolation.internal/probe"));
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
    if (request.method !== "POST" || !path.startsWith("/runtime/")) {
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
      address.agentId,
      address.conversationId,
      address.sessionId,
    ]);
    const session = env.SESSION.get(env.SESSION.idFromName(name));
    return await session.fetch(
      new Request(
        `https://session.internal/${path.slice("/runtime/".length)}`,
        {
          body: JSON.stringify(input.data),
          headers: {
            "Content-Type": "application/json",
            "x-fixture-principal":
              request.headers.get("x-fixture-principal") ??
              `user:${address.organizationId}`,
          },
          method: "POST",
        }
      )
    );
  },
};
