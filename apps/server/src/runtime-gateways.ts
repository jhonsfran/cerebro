/* eslint-disable max-classes-per-file -- These entrypoints share one private gateway protocol. */
import { id } from "@cerebro/contracts";
import type { ToolExecution } from "@cerebro/contracts";
import type { BoundApproval } from "@cerebro/contracts/tool-service";
import {
  AuditProjectionConflictError,
  projectAuditEvent,
} from "@cerebro/db/repositories/audit";
import {
  DurableOperationJournal,
  durableJournalDatabase,
} from "@cerebro/runtime/operation-journal";
import {
  toolCallSchema,
  createCapabilitySigner,
} from "@cerebro/tools/capability";
import { createMcpGateway } from "@cerebro/tools/mcp-gateway";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { WorkerEnv } from "./env.server";
import { GATEWAY_AUDIENCE } from "./runtime-composition";
import { createRuntimeRegistry } from "./runtime-configuration";
import {
  createCurrentAuthorization,
  createCurrentEntitlements,
  runtimeConfiguration,
} from "./runtime-services";
import { withDatabase } from "./services";

const reconciliation = z.strictObject({
  context: toolCallSchema.shape.context,
  operationId: z.string().min(1),
  options: z.strictObject({ deadlineAt: z.number().finite() }),
});
const approvalSchema = z.strictObject({
  actorPrincipalId: z.string(),
  agentId: z.string(),
  approverId: z.string(),
  argumentDigest: z.string(),
  connectorFingerprint: z.string(),
  connectorId: z.string(),
  delegationId: z.string().optional(),
  effect: z.enum(["read", "write"]),
  expiresAt: z.number().finite(),
  id: z.string(),
  operationId: z.string(),
  organizationId: z.string(),
  policyVersion: z.string(),
  principalId: z.string(),
  runId: z.string(),
  toolId: z.string(),
  toolVersion: z.string(),
});
const auditSchema = z.strictObject({
  agentId: z.string(),
  eventId: z.string(),
  kind: z.enum(["audit", "usage"]),
  name: z.string(),
  occurredAt: z.number().finite(),
  organizationId: z.string(),
  payload: z.unknown(),
  runId: z.string(),
  sessionId: z.string(),
});

export class GatewayJournal extends DurableObject<WorkerEnv> {
  private journal(): DurableOperationJournal<ToolExecution> {
    return new DurableOperationJournal(
      durableJournalDatabase(this.ctx.storage),
      "gateway"
    );
  }
  private async gateway() {
    const config = runtimeConfiguration(this.env);
    return createMcpGateway({
      approvals: this.journal(),
      audience: GATEWAY_AUDIENCE,
      authorizationPolicy: createCurrentAuthorization(this.env),
      credentials: (organizationId, connectorId) => {
        const tools = config.tools.filter(
          (entry) => entry.connectorId === connectorId
        );
        const [first] = tools;
        const credentials =
          first &&
          organizationId ===
            (this.env.CHANNEL_ORGANIZATION_ID ?? "local-company")
            ? {
                headers: first.credentials.headers,
                secrets: [
                  ...new Set(tools.flatMap((tool) => tool.credentials.secrets)),
                ],
              }
            : undefined;
        return Promise.resolve(credentials);
      },
      entitlementPolicy: createCurrentEntitlements(this.env),
      fetch: async (target, init) => {
        const url = new URL(
          target instanceof Request ? target.url : String(target)
        );
        if (config.mode === "fixture" && url.hostname === "fixture.invalid") {
          return await fetch(
            `${this.env.FIXTURE_URL}${url.pathname}${url.search}`,
            init
          );
        }
        return await fetch(target, init);
      },
      journal: this.journal(),
      registry: createRuntimeRegistry(config),
      signer: await createCapabilitySigner(config.gatewaySigningKey),
    });
  }
  override async fetch(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname;
    if (route === "/ready") {
      runtimeConfiguration(this.env);
      this.journal();
      await this.ctx.storage.sync();
      return Response.json({ ok: true });
    }
    if (route === "/approve") {
      const parsed = approvalSchema.parse(await request.json());
      const { delegationId, ...fields } = parsed;
      const approval: BoundApproval = {
        ...fields,
        actorPrincipalId: id.principal(parsed.actorPrincipalId),
        agentId: id.agent(parsed.agentId),
        approverId: id.principal(parsed.approverId),
        argumentDigest: id.digest(parsed.argumentDigest),
        connectorFingerprint: id.digest(parsed.connectorFingerprint),
        operationId: id.operation(parsed.operationId),
        organizationId: id.organization(parsed.organizationId),
        principalId: id.principal(parsed.principalId),
        runId: id.run(parsed.runId),
        toolId: id.tool(parsed.toolId),
        ...(delegationId ? { delegationId: id.delegation(delegationId) } : {}),
      };
      await this.journal().putApproval(approval);
      return Response.json({ ok: true });
    }
    const gateway = await this.gateway();
    if (route === "/reconcile") {
      const input = reconciliation.parse(await request.json());
      return Response.json(
        await gateway.reconcile(
          id.operation(input.operationId),
          input.context,
          input.options
        )
      );
    }
    return await gateway.fetch(request);
  }
}
export class TrustedGateway extends WorkerEntrypoint<WorkerEnv> {
  override async fetch(request: Request): Promise<Response> {
    const config = runtimeConfiguration(this.env);
    const route = new URL(request.url).pathname;
    let organizationId = this.env.CHANNEL_ORGANIZATION_ID ?? "local-company";
    if (route === "/invoke") {
      const signer = await createCapabilitySigner(config.gatewaySigningKey);
      const envelope: unknown = await request.clone().json();
      const verified = await signer.verify(envelope);
      if (!verified || verified.audience !== GATEWAY_AUDIENCE) {
        return Response.json(
          {
            code: "unauthorized",
            reason: "Invalid gateway capability.",
            status: "denied",
          },
          { status: 403 }
        );
      }
      ({ organizationId } = verified.call);
    } else if (route === "/approve" || route === "/reconcile") {
      if (
        request.headers.get("X-Cerebro-Gateway-Key") !==
        config.gatewaySigningKey
      ) {
        return Response.json(
          {
            code: "unauthorized",
            reason: "Trusted gateway access is required.",
            status: "denied",
          },
          { status: 403 }
        );
      }
      const payload = await request.clone().json();
      organizationId =
        route === "/approve"
          ? approvalSchema.parse(payload).organizationId
          : reconciliation.parse(payload).context.actor.organizationId;
    } else if (route !== "/ready") {
      return Response.json(
        { reason: "Unknown gateway route.", status: "invalid-input" },
        { status: 404 }
      );
    }
    return await this.env.GATEWAY_JOURNAL.get(
      this.env.GATEWAY_JOURNAL.idFromName(`gateway:${organizationId}`)
    ).fetch(request);
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
