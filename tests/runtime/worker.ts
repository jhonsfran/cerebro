import { getAgentByName } from "agents";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import { sessionName } from "../../packages/runtime/src/event-handler.ts";
import type { TestEnvironment } from "./environment.ts";

export { AuditSink } from "./audit-sink.ts";
export { FixtureEffectGateway } from "./fixture-gateway.ts";
export { LedgerMigrationProbe } from "./migration-probe.ts";
export { SessionAgent } from "../../packages/runtime/src/session-agent.ts";

const readAddress = (value: unknown): EventAddress | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.organizationId !== "string" ||
    typeof candidate.agentId !== "string" ||
    typeof candidate.conversationId !== "string"
  ) {
    return undefined;
  }
  return {
    agentId: candidate.agentId,
    conversationId: candidate.conversationId,
    organizationId: candidate.organizationId,
  };
};

const requestAddress = (value: unknown): EventAddress | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const { command } = candidate;
  const commandAddress =
    command && typeof command === "object" && "address" in command
      ? command.address
      : undefined;
  return (
    readAddress(candidate.event) ??
    readAddress(candidate.address) ??
    readAddress(commandAddress)
  );
};

const forwardRuntime = async (
  request: Request,
  env: TestEnvironment,
  path: string
): Promise<Response> => {
  const body = await request.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const address = requestAddress(parsed);
  if (!address) {
    return Response.json({ error: "Missing address" }, { status: 400 });
  }
  const session = await getAgentByName(env.SESSION, sessionName(address));
  return await session.fetch(
    new Request(`https://session.internal/${path.slice("/runtime/".length)}`, {
      body,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  );
};

const replayAudit = async (
  request: Request,
  env: TestEnvironment
): Promise<Response> => {
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
};

export default {
  async fetch(request: Request, env: TestEnvironment): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return Response.json({ ok: true });
    }
    if (path === "/audit/replay" && request.method === "POST") {
      return await replayAudit(request, env);
    }
    if (path.startsWith("/migration/")) {
      const name = path.split("/").at(2);
      if (!name) {
        return new Response(null, { status: 400 });
      }
      const probe = env.MIGRATION_PROBE.get(
        env.MIGRATION_PROBE.idFromName(name)
      );
      return await probe.fetch(request);
    }
    if (path.startsWith("/runtime/")) {
      return await forwardRuntime(request, env, path);
    }
    return new Response(null, { status: 404 });
  },
};
