/* eslint-disable max-classes-per-file -- The tool gateway and audit sink are separate service entrypoints. */
import { withDatabase } from "@cerebro/db";
/* eslint-disable max-classes-per-file -- The tool gateway and audit sink are separate service entrypoints. */
import {
  AuditProjectionConflictError,
  projectAuditEvent,
} from "@cerebro/db/repositories/audit";
import { createCapabilitySigner } from "@cerebro/tools/capability";
import { createMcpGateway } from "@cerebro/tools/mcp-gateway";
import { WorkerEntrypoint } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  createCurrentAuthorization,
  createCurrentEntitlements,
} from "./access";
import type { WorkerEnv } from "./bindings";
import {
  GATEWAY_AUDIENCE,
  runtimeConfiguration,
  runtimeRegistry,
} from "./config";

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

const createGateway = async (env: WorkerEnv) => {
  const config = runtimeConfiguration(env);
  return createMcpGateway({
    audience: GATEWAY_AUDIENCE,
    authorizationPolicy: createCurrentAuthorization(env),
    credentials: (organizationId, connectorId) => {
      const tools = config.tools.filter(
        (entry) => entry.connectorId === connectorId
      );
      const [first] = tools;
      const credentials =
        first &&
        organizationId === (env.CHANNEL_ORGANIZATION_ID ?? "local-company")
          ? {
              headers: first.credentials.headers,
              secrets: [
                ...new Set(tools.flatMap((tool) => tool.credentials.secrets)),
              ],
            }
          : undefined;
      return Promise.resolve(credentials);
    },
    entitlementPolicy: createCurrentEntitlements(env),
    registry: runtimeRegistry(config),
    signer: await createCapabilitySigner(config.gatewaySigningKey),
  });
};

// The gateway keeps no state. It dispatches a call only with a capability the
// trusted runtime signed after its authority and approval checks.
export class TrustedGateway extends WorkerEntrypoint<WorkerEnv> {
  override async fetch(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname;
    if (route === "/ready") {
      runtimeConfiguration(this.env);
      return Response.json({ ok: true });
    }
    if (route !== "/invoke") {
      return Response.json(
        { reason: "Unknown gateway route.", status: "invalid-input" },
        { status: 404 }
      );
    }
    const gateway = await createGateway(this.env);
    return await gateway.fetch(request);
  }
}
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
