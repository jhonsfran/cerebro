import { contextByPrincipal } from "@cerebro/channels/security";
import { createSlackApi } from "@cerebro/channels/slack-api";
import { deliverSlackReplies } from "@cerebro/channels/slack-replies";
import type { SlackDelivery } from "@cerebro/channels/slack-replies";
import type { SlackConfiguration } from "@cerebro/channels/types";
import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import { tryAdapter } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
import type { DomainSnapshot } from "@cerebro/contracts/session-service";
import { withDatabase } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import type { channelConversation } from "@cerebro/db/schema/agents";
import { Effect, Result } from "effect";

import type { WorkerEnv } from "../bindings";

type Conversation = typeof channelConversation.$inferSelect;
const options = (): ReadOptions => ({ deadlineAt: Date.now() + 10_000 });

// The Slack recipient must still be linked to the conversation owner.
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
      // An inactive principal has no context, so nothing is posted.
    }
    return context;
  });

// Posts this conversation's progress, answers, and approvals into its Slack
// thread. Delivery state lives in the session's own storage.
export const createSlackNotifier = (input: {
  readonly env: WorkerEnv;
  readonly storage: DurableObjectStorage;
  readonly conversation: Conversation;
  readonly slack: SlackConfiguration;
  readonly address: EventAddress;
  readonly agent: AgentDefinition;
  readonly authority: AuthorityService;
  readonly checkDependencies: (
    context: ExecutionContext,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
}) => {
  const { conversation, storage } = input;
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS cerebro_slack_delivery (key TEXT PRIMARY KEY, delivery TEXT NOT NULL)"
  );
  const store = {
    get: (key: string): SlackDelivery | undefined => {
      const [row] = storage.sql
        .exec<{ delivery: string }>(
          "SELECT delivery FROM cerebro_slack_delivery WHERE key=?",
          key
        )
        .toArray();
      return row ? (JSON.parse(row.delivery) as SlackDelivery) : undefined;
    },
    set: (key: string, delivery: SlackDelivery) => {
      storage.sql.exec(
        "INSERT INTO cerebro_slack_delivery VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET delivery=excluded.delivery",
        key,
        JSON.stringify(delivery)
      );
    },
  };
  const slack = createSlackApi(input.slack);
  // An answer is shared only while the recipient may still read the agent and
  // every source and tool result behind it.
  const canShare =
    (context: ExecutionContext) =>
    async (output: { readonly dependencies: ContentDependencies }) => {
      const allowed = await Effect.runPromise(
        Effect.result(
          Effect.gen(function* checkAnswer() {
            yield* input.authority.require(
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
            );
            yield* input.checkDependencies(
              context,
              output.dependencies,
              options()
            );
          })
        )
      );
      if (Result.isSuccess(allowed)) {
        return true;
      }
      if (allowed.failure._tag === "Denied") {
        return false;
      }
      throw allowed.failure;
    };
  return (snapshot: DomainSnapshot) =>
    tryAdapter(async () => {
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
    }, "Slack delivery is unavailable.");
};
