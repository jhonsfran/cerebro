import { resolvePrimaryConversationIn } from "@cerebro/channels/primary-conversations";
import type { SlackConfiguration } from "@cerebro/channels/types";
import type { EventAddress } from "@cerebro/contracts/events";
import { id } from "@cerebro/contracts/identity";
import { LegacyTimerReplyOriginSchema } from "@cerebro/contracts/timer-events";
import type { LegacyTimerReplyOrigin } from "@cerebro/contracts/timer-events";
import { withDatabase } from "@cerebro/db";
import type { channelConversation } from "@cerebro/db/schema/agents";
import { Schema } from "effect";

import type { WorkerEnv } from "../bindings";

type Conversation = typeof channelConversation.$inferSelect;
export const sourcePrimaryAddress = async (
  env: WorkerEnv,
  conversation: Conversation,
  primary: boolean
): Promise<EventAddress> => {
  const row = primary
    ? conversation
    : await withDatabase(env, (database) =>
        database.transaction((tx) =>
          resolvePrimaryConversationIn(tx, {
            agentId: conversation.agentId,
            organizationId: conversation.organizationId,
            ownerPrincipalId: conversation.ownerPrincipalId,
          })
        )
      );
  return {
    organizationId: id.organization(row.organizationId),
    agentId: id.agent(row.agentId),
    conversationId: id.conversation(row.conversationId),
    sessionId: id.session(row.sessionId),
  };
};
export const legacyTimerOrigin = (
  conversation: Conversation,
  slack: SlackConfiguration | undefined,
  address: EventAddress
): LegacyTimerReplyOrigin | undefined => {
  if (
    conversation.kind !== "slack" ||
    !slack ||
    !conversation.workspaceId ||
    !conversation.slackUserId ||
    !conversation.channelId ||
    !conversation.rootTimestamp
  ) {
    return;
  }
  return Schema.decodeUnknownSync(LegacyTimerReplyOriginSchema)({
    kind: "legacy-slack-timer",
    source: address,
    ownerPrincipalId: id.principal(conversation.ownerPrincipalId),
    authority: {
      appId: slack.appId,
      userId: conversation.slackUserId,
      thread: {
        workspaceId: conversation.workspaceId,
        channelId: conversation.channelId,
        rootTimestamp: conversation.rootTimestamp,
      },
    },
  });
};
