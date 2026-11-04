import { assertQueuePayloadSize } from "@cerebro/channels/queue-payload";
import { Denied, fromPortResult } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import {
  canonicalToolArguments,
  digestToolArguments,
} from "@cerebro/contracts/tools";
import { TeamCommandSchema, workCellName } from "@cerebro/contracts/work";
import type { WorkAdmission } from "@cerebro/contracts/work";
import { withDatabase } from "@cerebro/db";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import type { MetadataTransaction } from "@cerebro/runtime/session-agent";
import { TeamAgent as TeamHost } from "@cerebro/runtime/team-agent";
import { Effect, Schema } from "effect";

import type { WorkerEnv } from "./bindings";
import { slackSettings } from "./channels";
import { runtimeConfiguration } from "./config";
import { resolveSessionAddress } from "./session/agent";
import { createExecutionComposition } from "./session/execution";
import { authenticateSessionRequest } from "./session/proof";

export class TeamAgent extends TeamHost<WorkerEnv> {
  protected override async resolve(request: Request) {
    if (new URL(request.url).pathname !== "/control") {
      throw new Denied({
        code: "unauthorized",
        reason: "Invalid private team route.",
      });
    }
    const text = await request.clone().text();
    assertQueuePayloadSize(JSON.parse(text));
    const command = Schema.decodeUnknownSync(TeamCommandSchema, {
      onExcessProperty: "error",
    })(JSON.parse(text));
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
      !slack ||
      conversation.kind !== "slack" ||
      conversation.workspaceId !== slack.workspaceId ||
      conversation.agentId !== slack.agentId ||
      conversation.channelId !== command.work.sourceSlackThread.channelId ||
      conversation.rootTimestamp !==
        command.work.sourceSlackThread.rootTimestamp ||
      conversation.workspaceId !== command.work.sourceSlackThread.workspaceId
    ) {
      throw new Denied({
        code: "revoked",
        reason: "The Slack team source is no longer configured.",
      });
    }
    return command;
  }

  protected override async configure(
    work: WorkAdmission,
    metadata: MetadataTransaction
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
            true
          )
        );
      })
    );
  }
}
