import { id } from "@cerebro/contracts/identity";
import type { Approval, ToolExecution } from "@cerebro/contracts/tools";
import { createCapabilitySigner } from "@cerebro/tools/capability";
import { createMcpGateway } from "@cerebro/tools/mcp-gateway";
import { Agent } from "agents";
import { z } from "zod";

import { DurableOperationJournal } from "../../fixtures/journal-core.ts";
import { DoDatabase } from "./do-database.ts";
import {
  audience,
  authorizationPolicy,
  context,
  entitlementPolicy,
  organizationId,
  providerSecret,
  registry,
  signerSecret,
} from "./shared.ts";
import type { Environment } from "./shared.ts";

export class GatewayJournal extends Agent<Environment> {
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
      authorizationPolicy,
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
  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/approve") {
      this.journal().putApproval((await request.json()) as Approval);
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
