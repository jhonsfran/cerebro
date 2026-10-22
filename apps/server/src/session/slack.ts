import { contextByPrincipal } from "@cerebro/channels/security";
import { createSlackApi } from "@cerebro/channels/slack-api";
import { deliverSlackReplies } from "@cerebro/channels/slack-replies";
import type { SlackDelivery } from "@cerebro/channels/slack-replies";
import type { SlackConfiguration } from "@cerebro/channels/types";
import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import { Denied } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
import type { AgentDefinition } from "@cerebro/contracts/session";
import type { ChatSnapshot } from "@cerebro/contracts/session-service";
import { withDatabase } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import type { channelConversation } from "@cerebro/db/schema/agents";
import type { MetadataTransaction } from "@cerebro/runtime/session-agent";
import { Effect } from "effect";
import { z } from "zod";

import type { WorkerEnv } from "../bindings";

type Conversation = typeof channelConversation.$inferSelect;
const deliverySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("sent"), text: z.string(), ts: z.string() }),
  z.object({ state: z.enum(["unknown", "failed", "retry"]), text: z.string() }),
]);
const options = (): ReadOptions => ({ deadlineAt: Date.now() + 10_000 });

const currentRecipient = (env: WorkerEnv, conversation: Conversation) =>
  withDatabase(env, async (database) => {
    if (!conversation.workspaceId || !conversation.slackUserId) {
      return;
    }
    const link = await createIdentityRepository(database).resolveSlackLink(
      conversation.workspaceId,
      conversation.slackUserId
    );
    if (
      !link ||
      link.principalId !== conversation.ownerPrincipalId ||
      link.organizationId !== conversation.organizationId
    ) {
      return;
    }
    let context: ExecutionContext | undefined;
    try {
      context = await contextByPrincipal(
        database,
        conversation.organizationId,
        link.principalId
      );
    } catch {
      return;
    }
    return context;
  });

export const createSlackNotifier = (input: {
  readonly env: WorkerEnv;
  readonly storage: DurableObjectStorage;
  readonly metadata: MetadataTransaction;
  readonly conversation: Conversation;
  readonly slack: SlackConfiguration;
  readonly address: EventAddress;
  readonly agent: AgentDefinition;
  readonly authority: AuthorityService;
  readonly checkContent: (context: ExecutionContext) => Promise<void>;
}) => {
  const { conversation, storage } = input;
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS cerebro_slack_delivery (session_id TEXT NOT NULL, key TEXT NOT NULL, delivery TEXT NOT NULL, PRIMARY KEY(session_id, key))"
  );
  const store = {
    get: (key: string): Promise<SlackDelivery | undefined> =>
      input.metadata(() => {
        const [row] = storage.sql
          .exec<{ delivery: string }>(
            "SELECT delivery FROM cerebro_slack_delivery WHERE session_id=? AND key=?",
            input.address.sessionId,
            key
          )
          .toArray();
        return row ? deliverySchema.parse(JSON.parse(row.delivery)) : undefined;
      }),
    set: async (key: string, delivery: SlackDelivery) => {
      await input.metadata(() =>
        storage.sql.exec(
          "INSERT INTO cerebro_slack_delivery VALUES (?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET delivery=excluded.delivery",
          input.address.sessionId,
          key,
          JSON.stringify(delivery)
        )
      );
      await storage.sync();
    },
  };
  const slack = createSlackApi(input.slack);
  const canShare =
    (context: ExecutionContext) => async (): Promise<boolean> => {
      try {
        await Effect.runPromise(
          input.authority.require(
            {
              action: "read",
              address: input.address,
              context,
              pinnedAgent: input.agent,
              resource: {
                id: input.address.agentId,
                kind: "agent",
                organizationId: input.address.organizationId,
              },
            },
            options()
          )
        );
        await input.checkContent(context);
        return true;
      } catch (error) {
        const cause = error instanceof Error ? (error.cause ?? error) : error;
        if (cause instanceof Denied) {
          return false;
        }
        throw error;
      }
    };
  return async (snapshot: ChatSnapshot): Promise<void> => {
    if (!conversation.channelId || !conversation.rootTimestamp) {
      return;
    }
    const context = await currentRecipient(input.env, conversation);
    if (!context) {
      return;
    }
    await deliverSlackReplies({
      canShare: canShare(context),
      slack,
      snapshot,
      store,
      thread: {
        channelId: conversation.channelId,
        conversationId: conversation.conversationId,
        threadTs: conversation.rootTimestamp,
      },
    });
  };
};
