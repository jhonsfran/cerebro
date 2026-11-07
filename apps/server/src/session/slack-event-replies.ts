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
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { withDatabase } from "@cerebro/db";
import type { EventReplyServices } from "@cerebro/runtime/coordinator-replies";

import type { WorkerEnv } from "../bindings";

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
  configuration: SlackConfiguration | undefined
): EventReplyServices | undefined => {
  if (!configuration?.botToken) {
    return undefined;
  }
  return {
    destination: (event) =>
      withCurrentSlackAccess(() =>
        withDatabase(env, (database) =>
          readSlackReplyDestination(database, configuration, event)
        )
      ),
    authorize: (destination) =>
      withCurrentSlackAccess(async () => {
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
