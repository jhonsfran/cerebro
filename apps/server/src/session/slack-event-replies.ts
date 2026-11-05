import { createSlackApi } from "@cerebro/channels/slack-api";
import {
  readSlackPrimaryEvent,
  readSlackReplyDestination,
  slackEventKey,
} from "@cerebro/channels/slack-primary-events";
import { deliverSlackMessage } from "@cerebro/channels/slack-replies";
import { ChannelError } from "@cerebro/channels/types";
import type { SlackConfiguration } from "@cerebro/channels/types";
import { Denied } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { AgentDefinition } from "@cerebro/contracts/session";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { withDatabase } from "@cerebro/db";
import type { EventReplyServices } from "@cerebro/runtime/coordinator-replies";
import { Effect } from "effect";

import { createCurrentAuthority } from "../access";
import type { WorkerEnv } from "../bindings";
import { requireLegacyTimerDestination } from "./legacy-timer-replies";

export const withCurrentSlackAccess = async <Value>(
  operation: () => Promise<Value>
): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ChannelError && error.status === 403) {
      throw new Denied({
        code: "revoked",
        reason: "The Slack destination is no longer authorized.",
      });
    }
    throw error;
  }
};

export const createSlackEventReplies = (
  env: WorkerEnv,
  configuration: SlackConfiguration | undefined,
  primary: boolean,
  access: {
    readonly agent: AgentDefinition;
    readonly owner: () => Promise<ExecutionContext>;
  }
): EventReplyServices | undefined => {
  if (!configuration?.botToken) {
    return undefined;
  }
  const current = createCurrentAuthority(env);
  return {
    destination: async (event) => {
      if ("kind" in event) {
        await requireLegacyTimerDestination(env, configuration, event);
        return event;
      }
      if (!primary) {
        throw new Denied({
          code: "revoked",
          reason: "The conversation is not a primary Slack target.",
        });
      }
      return withCurrentSlackAccess(() =>
        withDatabase(env, (database) =>
          readSlackReplyDestination(database, configuration, event)
        )
      );
    },
    authorize: (destination) =>
      withCurrentSlackAccess(async () => {
        if ("kind" in destination) {
          await requireLegacyTimerDestination(env, configuration, destination);
          const context = await access.owner();
          if (
            context.actor.id !== destination.ownerPrincipalId ||
            context.actor.organizationId !==
              destination.source.organizationId ||
            access.agent.agentId !== destination.source.agentId ||
            access.agent.organizationId !== destination.source.organizationId
          ) {
            throw new Denied({
              code: "unauthorized",
              reason:
                "The timer reply source belongs to another owner or agent.",
            });
          }
          await Effect.runPromise(
            current.require(
              {
                action: "read",
                address: destination.source,
                context,
                pinnedAgent: access.agent,
                resource: {
                  kind: "agent",
                  id: destination.source.agentId,
                  organizationId: destination.source.organizationId,
                },
              },
              { deadlineAt: Date.now() + 10_000 }
            )
          );
          return;
        }
        const { decision } = await withDatabase(env, (database) =>
          readSlackPrimaryEvent({
            database,
            configuration,
            address: destination.source,
            eventKey: slackEventKey(
              destination.source.organizationId,
              destination.authority
            ),
          })
        );
        if (
          decision.ownerPrincipalId !== destination.ownerPrincipalId ||
          canonicalToolArguments(decision.authority) !==
            canonicalToolArguments(destination.authority)
        ) {
          throw new Denied({
            code: "revoked",
            reason: "The Slack reply authority changed.",
          });
        }
      }),
    deliver: async ({ destination, key, text, store, beforePost }) => {
      await deliverSlackMessage({
        message: { key, text },
        slack: createSlackApi(configuration),
        store,
        thread: {
          channelId: destination.authority.thread.channelId,
          threadTs: destination.authority.thread.rootTimestamp,
          conversationId: destination.source.conversationId,
        },
        beforePost: async () => {
          try {
            await beforePost();
            return true;
          } catch (error) {
            if (error instanceof Denied) {
              return false;
            }
            throw error;
          }
        },
      });
    },
  };
};
