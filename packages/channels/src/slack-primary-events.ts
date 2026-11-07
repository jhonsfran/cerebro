import {
  botEventId,
  BotEventSchema,
  BotEventSourceSchema,
} from "@cerebro/contracts/bot-events";
import type { BotEvent } from "@cerebro/contracts/bot-events";
import type { EventAddress } from "@cerebro/contracts/events";
import type {
  SlackPrimaryDecision,
  SlackReplyDestination,
} from "@cerebro/contracts/slack-events";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type { Database } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import {
  channelConversation,
  channelSlackEventReceipt,
} from "@cerebro/db/schema/agents";
import { eq } from "drizzle-orm";
import { Schema } from "effect";

import { isPrimaryConversation } from "./primary-conversations";
import { parseSlackEventDecision } from "./slack-event-receipts";
import { ChannelError } from "./types";
import type { SlackConfiguration } from "./types";

const sameAddress = (left: EventAddress, right: EventAddress) =>
  left.organizationId === right.organizationId &&
  left.agentId === right.agentId &&
  left.conversationId === right.conversationId &&
  left.sessionId === right.sessionId;

export const slackEventKey = (
  organizationId: string,
  authority: Pick<
    SlackPrimaryDecision["authority"],
    "appId" | "eventId" | "thread"
  >
): string =>
  `slack:${organizationId}:${authority.appId}:${authority.thread.workspaceId}:${authority.eventId}`;

export const readSlackPrimaryEvent = async (input: {
  readonly database: Database;
  readonly configuration: SlackConfiguration;
  readonly eventKey: string;
  readonly address: EventAddress;
}) => {
  const { database, configuration, address } = input;
  const [receipt] = await database
    .select()
    .from(channelSlackEventReceipt)
    .where(eq(channelSlackEventReceipt.eventKey, input.eventKey));
  const decision = receipt && parseSlackEventDecision(receipt.decision);
  if (!decision || decision.kind !== "primary-events-v2") {
    throw new ChannelError(
      403,
      "forbidden",
      "This Slack event has no primary decision."
    );
  }
  const { authority } = decision;
  const link = await createIdentityRepository(database).resolveSlackLink(
    authority.thread.workspaceId,
    authority.userId
  );
  const [conversation] = await database
    .select()
    .from(channelConversation)
    .where(eq(channelConversation.conversationId, address.conversationId));
  if (
    input.eventKey !== slackEventKey(address.organizationId, authority) ||
    authority.appId !== configuration.appId ||
    authority.thread.workspaceId !== configuration.workspaceId ||
    !link ||
    link.organizationId !== address.organizationId ||
    link.principalId !== decision.ownerPrincipalId ||
    !decision.targets.some((target) => sameAddress(target, address)) ||
    !conversation ||
    conversation.organizationId !== address.organizationId ||
    conversation.agentId !== address.agentId ||
    conversation.sessionId !== address.sessionId ||
    conversation.ownerPrincipalId !== decision.ownerPrincipalId ||
    !(await isPrimaryConversation(conversation))
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "The saved Slack primary target is no longer accessible."
    );
  }
  return { decision, conversation };
};

export const primarySlackBotEvent = async (
  decision: SlackPrimaryDecision,
  address: EventAddress
): Promise<BotEvent> => {
  const source = Schema.decodeUnknownSync(BotEventSourceSchema, {
    onExcessProperty: "error",
  })({
    kind: "slack",
    eventId: decision.authority.eventId,
    thread: decision.authority.thread,
  });
  return Schema.decodeUnknownSync(BotEventSchema, {
    onExcessProperty: "error",
  })({
    version: 1,
    id: await botEventId(address, source),
    coordinator: address,
    ownerPrincipalId: decision.ownerPrincipalId,
    source,
    replyTo: { kind: "slack", thread: decision.authority.thread },
    content: { text: decision.text, reference: null },
    dependencies: { sourceIds: [], toolIds: [] },
  });
};

export const readSlackReplyDestination = async (
  database: Database,
  configuration: SlackConfiguration,
  event: BotEvent
): Promise<SlackReplyDestination> => {
  if (event.source.kind !== "slack" || event.replyTo?.kind !== "slack") {
    throw new ChannelError(
      403,
      "forbidden",
      "The event has no Slack reply destination."
    );
  }
  const authority = {
    appId: configuration.appId,
    eventId: event.source.eventId,
    thread: event.source.thread,
  };
  const { decision } = await readSlackPrimaryEvent({
    database,
    configuration,
    address: event.coordinator,
    eventKey: slackEventKey(event.coordinator.organizationId, authority),
  });
  if (
    decision.ownerPrincipalId !== event.ownerPrincipalId ||
    decision.text !== event.content.text ||
    canonicalToolArguments(decision.authority.thread) !==
      canonicalToolArguments(event.source.thread) ||
    canonicalToolArguments(event.replyTo.thread) !==
      canonicalToolArguments(event.source.thread)
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "The original Slack event changed."
    );
  }
  return {
    authority: decision.authority,
    ownerPrincipalId: decision.ownerPrincipalId,
    source: event.coordinator,
  };
};
