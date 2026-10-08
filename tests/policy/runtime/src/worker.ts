import { z } from "zod";

import { agentId, organizationId } from "./fixture-identity.ts";
import type { Environment } from "./shared.ts";

export { GatewayJournal } from "./gateway-journal.ts";
export { TrustedGateway } from "./trusted-gateway.ts";
export { ToolsRuntime } from "./tools-runtime.ts";
const addressSchema = z.object({
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  organizationId: z.string().min(1),
  sessionId: z.string().min(1),
});
export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return Response.json({ ok: true });
    }
    if (path.startsWith("/private/gateway/")) {
      const url = new URL(request.url);
      url.pathname = path.replace("/private/gateway", "");
      return await env.GATEWAY.fetch(new Request(url, request));
    }
    if (!path.startsWith("/runtime/")) {
      return Response.json({ error: "Route not found" }, { status: 404 });
    }
    const parsed = z
      .object({ address: addressSchema })
      .safeParse(await request.clone().json());
    if (!parsed.success) {
      return Response.json(
        { error: "Complete address required" },
        { status: 400 }
      );
    }
    const { address } = parsed.data;
    if (
      address.organizationId !== organizationId ||
      address.agentId !== agentId
    ) {
      return Response.json(
        {
          code: "unauthorized",
          reason: "Foreign policy host",
          status: "denied",
        },
        { status: 403 }
      );
    }
    const stub = env.RUNTIME.get(
      env.RUNTIME.idFromName(
        JSON.stringify([
          address.organizationId,
          address.agentId,
          address.conversationId,
          address.sessionId,
        ])
      )
    );
    const url = new URL(request.url);
    url.pathname = path.slice("/runtime".length);
    return await stub.fetch(new Request(url, request));
  },
};
