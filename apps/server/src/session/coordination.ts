import { assertQueuePayloadSize } from "@cerebro/channels/queue-payload";
import type { SlackConfiguration } from "@cerebro/channels/types";
import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, fromPortResult } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type {
  ContentDependencies,
  AgentDefinition,
} from "@cerebro/contracts/session";
import { SlackThreadSchema } from "@cerebro/contracts/work";
import type { CoordinationProfile } from "@cerebro/contracts/work";
import { withDatabase } from "@cerebro/db";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import type { channelConversation } from "@cerebro/db/schema/agents";
import type { CoordinationServices } from "@cerebro/runtime/coordinator-work";
import { Effect, Schema } from "effect";

import { createCurrentAuthority } from "../access";
import type { WorkerEnv } from "../bindings";

export const createCoordinatorServices = (options: {
  readonly env: WorkerEnv;
  readonly address: EventAddress;
  readonly agent: AgentDefinition;
  readonly authority: AuthorityService;
  readonly conversation: typeof channelConversation.$inferSelect;
  readonly profile?: CoordinationProfile;
  readonly contentDependencies: () => Promise<ContentDependencies>;
  readonly slack?: SlackConfiguration;
  readonly ownerContext: () => Effect.Effect<ExecutionContext, ContractFailure>;
}): CoordinationServices | undefined => {
  const { profile, conversation, slack, address } = options;
  if (
    !profile ||
    !slack ||
    conversation.kind !== "slack" ||
    conversation.agentId !== slack.agentId ||
    conversation.workspaceId !== slack.workspaceId
  ) {
    return;
  }
  const ownerPrincipalId = id.principal(conversation.ownerPrincipalId);
  const thread = Schema.decodeUnknownSync(SlackThreadSchema)({
    channelId: conversation.channelId,
    workspaceId: conversation.workspaceId,
    rootTimestamp: conversation.rootTimestamp,
  });
  return {
    ownerPrincipalId,
    contentDependencies: options.contentDependencies,
    profile,
    thread,
    sendCommand: async (command) => {
      assertQueuePayloadSize(command);
      await options.env.TEAM_COMMANDS.send(command, { contentType: "json" });
    },
    resolveRolePins: async () => {
      const context = await Effect.runPromise(options.ownerContext());
      if (
        context.actor.id !== ownerPrincipalId ||
        context.actor.organizationId !== address.organizationId
      ) {
        throw new Denied({
          code: "unauthorized",
          reason: "The coordinator does not own this source.",
        });
      }
      const readOptions = { deadlineAt: Date.now() + 10_000 };
      await Effect.runPromise(
        options.authority.require(
          {
            action: "execute",
            address,
            context,
            pinnedAgent: options.agent,
            model: options.agent.model,
            resource: {
              kind: "agent",
              id: options.agent.agentId,
              organizationId: address.organizationId,
            },
          },
          readOptions
        )
      );
      const current = createCurrentAuthority(options.env);
      const pin = async (agentId: CoordinationProfile["leadAgentId"]) => {
        const result = await withDatabase(options.env, (database) =>
          createAgentRepository(database).get(
            address.organizationId,
            agentId,
            "latest",
            readOptions
          )
        );
        const definition = await Effect.runPromise(fromPortResult(result));
        await Effect.runPromise(
          current.require(
            {
              action: "execute",
              address: { ...address, agentId },
              context,
              pinnedAgent: definition,
              model: definition.model,
              resource: {
                kind: "agent",
                id: agentId,
                organizationId: address.organizationId,
              },
            },
            readOptions
          )
        );
        return {
          agentId: definition.agentId,
          agentVersion: definition.version,
        };
      };
      const [lead, worker] = await Promise.all([
        pin(profile.leadAgentId),
        pin(profile.workerAgentId),
      ]);
      return { lead, worker };
    },
  };
};
