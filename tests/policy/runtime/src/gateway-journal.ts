import { id } from "@cerebro/contracts/identity";
import type { ToolExecution } from "@cerebro/contracts/tools";
import {
  boundCapabilitySchema,
  createCapabilitySigner,
} from "@cerebro/tools/capability";
import { createMcpGateway } from "@cerebro/tools/mcp-gateway";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { DurableOperationJournal } from "../../fixtures/journal-core.ts";
import { DoDatabase } from "./do-database.ts";
import {
  audience,
  createAuthorizationPolicy,
  gatewayProof,
  context,
  entitlementPolicy,
  organizationId,
  providerSecret,
  registry,
  signerSecret,
} from "./shared.ts";
import type { Environment } from "./shared.ts";

export class GatewayJournal extends DurableObject<Environment> {
  private enabled(): boolean {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS policy_authority(id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO policy_authority VALUES(1,1)"
    );
    const [row] = this.ctx.storage.sql
      .exec<{ enabled: number }>(
        "SELECT enabled FROM policy_authority WHERE id=1"
      )
      .toArray();
    return row?.enabled === 1;
  }
  private journal(): DurableOperationJournal<ToolExecution> {
    return new DurableOperationJournal(
      new DoDatabase(this.ctx.storage),
      "gateway"
    );
  }
  private async gateway() {
    return createMcpGateway({
      approvals: this.journal(),
      audience,
      authorizationPolicy: createAuthorizationPolicy(() => this.enabled()),
      credentials: (company, connector) =>
        Promise.resolve(
          company === organizationId && connector === "s4-connector"
            ? {
                headers: { Authorization: `Bearer ${providerSecret}` },
                secrets: [providerSecret],
              }
            : undefined
        ),
      entitlementPolicy,
      fetch: async (target, init) => {
        const url = new URL(
          target instanceof Request ? target.url : String(target)
        );
        if (url.hostname === "fixture.invalid") {
          return await fetch(
            `${this.env.FIXTURE_URL}${url.pathname}${url.search}`,
            init
          );
        }
        return await fetch(target, init);
      },
      journal: this.journal(),
      registry,
      signer: await createCapabilitySigner(signerSecret),
    });
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (
      ["/approve", "/reconcile", "/authority", "/access", "/journal"].includes(
        path
      ) &&
      request.headers.get("x-fixture-private-proof") !== gatewayProof
    ) {
      return Response.json(
        {
          code: "unauthorized",
          reason: "Private gateway control proof required",
          status: "denied",
        },
        { status: 403 }
      );
    }
    if (path === "/authority") {
      return Response.json({ enabled: this.enabled() });
    }
    if (path === "/access") {
      const input = z
        .strictObject({ enabled: z.boolean() })
        .parse(await request.json());
      this.enabled();
      this.ctx.storage.sql.exec(
        "UPDATE policy_authority SET enabled=? WHERE id=1",
        input.enabled ? 1 : 0
      );
      await this.ctx.storage.sync();
      return Response.json(input);
    }
    if (path === "/journal") {
      const input = z
        .strictObject({ operationId: z.string() })
        .parse(await request.json());
      return Response.json(
        await this.journal().read(
          organizationId,
          id.operation(input.operationId),
          { deadlineAt: Date.now() + 30_000 }
        )
      );
    }
    if (path === "/approve") {
      const approval = boundCapabilitySchema
        .extend({
          approverId: z.string().transform(id.principal),
          id: z.string(),
        })
        .parse(await request.json());
      this.journal().putApproval(approval);
      await this.ctx.storage.sync();
      return Response.json({ ok: true });
    }
    if (path === "/reconcile") {
      const input = z
        .strictObject({ operationId: z.string() })
        .parse(await request.json());
      const resultSnapshot1 = await this.gateway();
      return Response.json(
        await resultSnapshot1.reconcile(
          id.operation(input.operationId),
          context,
          {
            deadlineAt: Date.now() + 30_000,
          }
        )
      );
    }
    const resultSnapshot2 = await this.gateway();
    const response = await resultSnapshot2.fetch(request);
    await this.ctx.storage.sync();
    return response;
  }
}
