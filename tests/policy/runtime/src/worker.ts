import type { Environment } from "./shared.ts";

export { GatewayJournal } from "./gateway-journal.ts";
export { TrustedGateway } from "./trusted-gateway.ts";
export { ToolsRuntime } from "./tools-runtime.ts";

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    if (new URL(request.url).pathname === "/health") {
      return Response.json({ ok: true });
    }
    try {
      return await env.RUNTIME.get(env.RUNTIME.idFromName("s4-session")).fetch(
        request
      );
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Runtime failed" },
        { status: 500 }
      );
    }
  },
};
