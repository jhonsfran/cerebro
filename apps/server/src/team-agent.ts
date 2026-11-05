import { assertQueuePayloadSize } from "@cerebro/channels/queue-payload";
import { contextByPrincipal } from "@cerebro/channels/security";
import { prepareTeamReport } from "@cerebro/channels/team-reports";
import { Denied, fromPortResult } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import { normalizeTeamCommand } from "@cerebro/contracts/team-events";
import type { TeamEventReturn } from "@cerebro/contracts/team-events";
import {
  canonicalToolArguments,
  digestToolArguments,
} from "@cerebro/contracts/tools";
import { workCellName } from "@cerebro/contracts/work";
import type {
  WorkAdmission,
  WorkReport,
  TeamReportDelivery,
} from "@cerebro/contracts/work";
import { withDatabase } from "@cerebro/db";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import type { MetadataTransaction } from "@cerebro/runtime/session-agent";
import { TeamAgent as TeamHost } from "@cerebro/runtime/team-agent";
import type { ReadTeamRoleImports } from "@cerebro/runtime/team-content";
import { teamCommandDependencies } from "@cerebro/runtime/team-state";
import { Effect } from "effect";

import { checkContentDependencies, createCurrentAuthority } from "./access";
import type { WorkerEnv } from "./bindings";
import { slackSettings } from "./channels";
import { runtimeConfiguration } from "./config";
import { resolveSessionAddress } from "./session/agent";
import {
  isCoordinatorConversation,
  requireLegacySourceMatch,
} from "./session/coordination";
import { createExecutionComposition } from "./session/execution";
import { authenticateSessionRequest } from "./session/proof";

export class TeamAgent extends TeamHost<WorkerEnv> {
  private async authorizeEventSource(
    work: WorkAdmission,
    dependencies: ContentDependencies
  ): Promise<void> {
    const identity = {
      organizationId: work.key.organizationId,
      ownerPrincipalId: work.key.ownerPrincipalId,
    };
    const options = { deadlineAt: Date.now() + 10_000 };
    const { conversation } = await Effect.runPromise(
      resolveSessionAddress(this.env, work.sourceEventAddress, identity)
    );
    requireLegacySourceMatch(work, conversation);
    const { context, definition } = await withDatabase(
      this.env,
      async (database) => ({
        context: await contextByPrincipal(
          database,
          identity.organizationId,
          identity.ownerPrincipalId
        ),
        definition: await createAgentRepository(database).get(
          identity.organizationId,
          work.sourceEventAddress.agentId,
          "latest",
          options
        ),
      })
    );
    const pinnedAgent = await Effect.runPromise(fromPortResult(definition));
    await Effect.runPromise(
      createCurrentAuthority(this.env).require(
        {
          action: "read",
          address: work.sourceEventAddress,
          context,
          pinnedAgent,
          resource: {
            kind: "agent",
            id: work.sourceEventAddress.agentId,
            organizationId: identity.organizationId,
          },
        },
        options
      )
    );
    const result = await withDatabase(this.env, (database) =>
      checkContentDependencies(
        this.env,
        database,
        context,
        dependencies,
        options
      )
    );
    await Effect.runPromise(fromPortResult(result));
  }
  protected override eventReturnTransport(work: WorkAdmission) {
    return {
      authorize: (dependencies: ContentDependencies) =>
        this.authorizeEventSource(work, dependencies),
      send: async (delivery: TeamEventReturn) => {
        assertQueuePayloadSize(delivery);
        await this.env.TEAM_REPORTS.send(delivery, { contentType: "json" });
      },
    };
  }
  protected override reportTransport(work: WorkAdmission) {
    return {
      prepare: (report: WorkReport) => prepareTeamReport(work, report),
      send: async (delivery: TeamReportDelivery) => {
        assertQueuePayloadSize(delivery);
        await this.env.TEAM_REPORTS.send(delivery);
      },
    };
  }
  protected override async resolve(request: Request) {
    if (new URL(request.url).pathname !== "/control") {
      throw new Denied({
        code: "unauthorized",
        reason: "Invalid private team route.",
      });
    }
    const text = await request.clone().text();
    assertQueuePayloadSize(JSON.parse(text));
    const { command, wire, event } = normalizeTeamCommand(JSON.parse(text));
    if (this.ctx.id.name !== workCellName(command.work.key)) {
      throw new Denied({
        code: "unauthorized",
        reason: "The command addresses another team.",
      });
    }
    const config = runtimeConfiguration(this.env);
    const identity = {
      organizationId: command.work.key.organizationId,
      ownerPrincipalId: command.work.key.ownerPrincipalId,
    };
    const resolved = await authenticateSessionRequest(
      request,
      config.gatewaySigningKey,
      identity
    );
    if (
      canonicalToolArguments(resolved.address) !==
        canonicalToolArguments(command.work.sourceEventAddress) ||
      resolved.context.actor.id !== identity.ownerPrincipalId
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "The team source identity does not match.",
      });
    }
    const slack = slackSettings(this.env);
    const { conversation } = await Effect.runPromise(
      resolveSessionAddress(this.env, resolved.address, identity)
    );
    if (
      !config.coordination ||
      !isCoordinatorConversation(conversation, slack)
    ) {
      throw new Denied({
        code: "revoked",
        reason: "The team source is no longer configured.",
      });
    }
    requireLegacySourceMatch(command.work, conversation);
    if (event) {
      await this.authorizeEventSource(
        command.work,
        teamCommandDependencies(command)
      );
    }
    return wire;
  }

  protected override async configure(
    work: WorkAdmission,
    metadata: MetadataTransaction,
    importedDependencies: ReadTeamRoleImports
  ) {
    const pins = [
      work.lead,
      ...Array.from({ length: work.limits.maxWorkers }, () => work.worker),
    ];
    return await Promise.all(
      pins.map(async (pin, index) => {
        const result = await withDatabase(this.env, (database) =>
          createAgentRepository(database).get(
            work.key.organizationId,
            pin.agentId,
            pin.agentVersion,
            { deadlineAt: Date.now() + 10_000 }
          )
        );
        const agent = await Effect.runPromise(fromPortResult(result));
        const digest = await digestToolArguments({
          key: work.key,
          role: index,
        });
        const address = {
          organizationId: work.key.organizationId,
          agentId: pin.agentId,
          conversationId: id.conversation(`team:${digest}`),
          sessionId: id.session(`team:${digest}`),
        };
        return await Effect.runPromise(
          createExecutionComposition(
            this.env,
            this.ctx.storage,
            work.sourceEventAddress,
            address,
            agent,
            work.key.ownerPrincipalId,
            metadata,
            true,
            () => importedDependencies(index)
          )
        );
      })
    );
  }
}
