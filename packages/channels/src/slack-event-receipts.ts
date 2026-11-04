import type { Database } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import {
  channelConversation,
  channelSlackEventReceipt,
} from "@cerebro/db/schema/agents";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { digest } from "./security";
import type { slackCallbackSchema } from "./slack-events";
import { ChannelError } from "./types";
import type { ChannelOptions, SlackConfiguration } from "./types";

const LINK_COMMAND = /^(?:link|\/link)\s+(?<code>[a-f0-9]{64})$/iu;
const identifier = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value);
const ignoredReason = z.enum([
  "bot",
  "subtype",
  "mention",
  "unsupported",
  "unlinked",
  "link-command",
]);
const decisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("admit"),
    ownerPrincipalId: identifier,
    sourceEventAddress: z.strictObject({
      agentId: identifier,
      conversationId: identifier,
      organizationId: identifier,
      sessionId: identifier,
    }),
  }),
  z.strictObject({ kind: z.literal("ignored"), reason: ignoredReason }),
]);
type SlackEventDecision = z.infer<typeof decisionSchema>;
type SlackCallback = z.infer<typeof slackCallbackSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
interface DirectMessage {
  readonly channel: string;
  readonly text: string;
  readonly ts: string;
  readonly threadTs?: string;
  readonly user: string;
}
type SlackInput =
  | {
      readonly kind: "ignored";
      readonly reason: "bot" | "subtype" | "mention" | "unsupported";
    }
  | { readonly kind: "message"; readonly message: DirectMessage }
  | {
      readonly kind: "link";
      readonly message: DirectMessage;
      readonly code: string;
    };

const classify = (event: SlackCallback["event"]): SlackInput => {
  if (event.bot_id) {
    return { kind: "ignored", reason: "bot" };
  }
  if (event.subtype) {
    return { kind: "ignored", reason: "subtype" };
  }
  if (event.type === "app_mention") {
    return { kind: "ignored", reason: "mention" };
  }
  const { channel, text, ts, user } = event;
  if (
    event.type !== "message" ||
    event.channel_type !== "im" ||
    !user ||
    !channel?.startsWith("D") ||
    !ts ||
    !text
  ) {
    return { kind: "ignored", reason: "unsupported" };
  }
  const message = { channel, text, threadTs: event.thread_ts, ts, user };
  const code = text.match(LINK_COMMAND)?.groups?.code;
  return code ? { code, kind: "link", message } : { kind: "message", message };
};

const bindConversation = async (
  database: Transaction,
  options: ChannelOptions,
  configuration: SlackConfiguration,
  message: DirectMessage,
  principalId: string
) => {
  const rootTimestamp = message.threadTs ?? message.ts;
  const bindingKey = `pi-identity-v1:slack:${await digest({ agentId: configuration.agentId, channelId: message.channel, organizationId: options.organizationId, principalId, rootTimestamp, userId: message.user, workspaceId: configuration.workspaceId })}`;
  const conversationId = `conversation:${await digest(bindingKey)}`;
  await database
    .insert(channelConversation)
    .values({
      agentId: configuration.agentId,
      bindingKey,
      channelId: message.channel,
      conversationId,
      engine: "pi-identity-v1",
      kind: "slack",
      organizationId: options.organizationId,
      ownerPrincipalId: principalId,
      rootTimestamp,
      sessionId: `session:${await digest({ agentId: configuration.agentId, conversationId, organizationId: options.organizationId })}`,
      slackUserId: message.user,
      workspaceId: configuration.workspaceId,
    })
    .onConflictDoNothing();
  const [conversation] = await database
    .select()
    .from(channelConversation)
    .where(eq(channelConversation.conversationId, conversationId));
  if (!conversation) {
    throw new Error("The Slack conversation insert returned no binding.");
  }
  return conversation;
};

export const resolveSlackEventDecision = async (
  database: Database,
  options: ChannelOptions,
  configuration: SlackConfiguration,
  payload: SlackCallback
) => {
  const input = classify(payload.event);
  const eventKey = `slack:${options.organizationId}:${configuration.appId}:${configuration.workspaceId}:${payload.event_id}`;
  const payloadDigest = await digest({
    agentId: configuration.agentId,
    callback: payload,
  });
  const result = await database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${eventKey}))`);
    const [prior] = await tx
      .select()
      .from(channelSlackEventReceipt)
      .where(eq(channelSlackEventReceipt.eventKey, eventKey));
    if (prior) {
      if (prior.digest !== payloadDigest) {
        throw new ChannelError(
          409,
          "digest-mismatch",
          "The Slack event changed."
        );
      }
      const parsed = decisionSchema.safeParse(prior.decision);
      if (!parsed.success) {
        throw new ChannelError(
          503,
          "unavailable",
          "The saved Slack decision is invalid."
        );
      }
      return { created: false, decision: parsed.data };
    }
    let decision: SlackEventDecision;
    if (input.kind === "message") {
      const link = await createIdentityRepository(tx).resolveSlackLink(
        configuration.workspaceId,
        input.message.user
      );
      if (!link || link.organizationId !== options.organizationId) {
        decision = { kind: "ignored", reason: "unlinked" };
      } else {
        const conversation = await bindConversation(
          tx,
          options,
          configuration,
          input.message,
          link.principalId
        );
        decision = {
          kind: "admit",
          ownerPrincipalId: link.principalId,
          sourceEventAddress: {
            agentId: conversation.agentId,
            conversationId: conversation.conversationId,
            organizationId: conversation.organizationId,
            sessionId: conversation.sessionId,
          },
        };
      }
    } else {
      decision = {
        kind: "ignored",
        reason: input.kind === "link" ? "link-command" : input.reason,
      };
    }
    await tx
      .insert(channelSlackEventReceipt)
      .values({ decision, digest: payloadDigest, eventKey });
    return { created: true, decision };
  });
  return { ...result, eventKey, input };
};

export const readSlackEventTarget = async (
  database: Database,
  options: ChannelOptions,
  configuration: SlackConfiguration,
  decision: Extract<SlackEventDecision, { kind: "admit" }>,
  message: DirectMessage
) => {
  const link = await createIdentityRepository(database).resolveSlackLink(
    configuration.workspaceId,
    message.user
  );
  const { sourceEventAddress: address } = decision;
  const [conversation] = await database
    .select()
    .from(channelConversation)
    .where(eq(channelConversation.conversationId, address.conversationId));
  if (
    !link ||
    link.organizationId !== options.organizationId ||
    link.principalId !== decision.ownerPrincipalId ||
    !conversation ||
    conversation.organizationId !== options.organizationId ||
    conversation.organizationId !== address.organizationId ||
    conversation.ownerPrincipalId !== decision.ownerPrincipalId ||
    conversation.agentId !== address.agentId ||
    conversation.agentId !== configuration.agentId ||
    conversation.sessionId !== address.sessionId ||
    conversation.kind !== "slack" ||
    conversation.engine !== "pi-identity-v1" ||
    conversation.workspaceId !== configuration.workspaceId ||
    conversation.channelId !== message.channel ||
    conversation.slackUserId !== message.user ||
    conversation.rootTimestamp !== (message.threadTs ?? message.ts)
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "The saved Slack event target is no longer accessible."
    );
  }
  return conversation;
};
