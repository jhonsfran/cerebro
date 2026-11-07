import type { EventAddress } from "@cerebro/contracts/events";
import type { SlackPrimaryDecision } from "@cerebro/contracts/slack-events";
import {
  TriggerOriginSchema,
  TriggerSchema,
  triggerId,
} from "@cerebro/contracts/triggers";
import type { Trigger } from "@cerebro/contracts/triggers";
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

/** The trigger one saved Slack decision raises for one target, with the thread as its reply destination. */
export const primarySlackTrigger = async (
  decision: SlackPrimaryDecision,
  address: EventAddress
): Promise<Trigger> => {
  const origin = Schema.decodeUnknownSync(TriggerOriginSchema, {
    onExcessProperty: "error",
  })({
    kind: "slack",
    eventId: decision.authority.eventId,
    thread: decision.authority.thread,
  });
  return Schema.decodeUnknownSync(TriggerSchema, {
    onExcessProperty: "error",
  })({
    version: 2,
    id: await triggerId(address, origin),
    address,
    ownerPrincipalId: decision.ownerPrincipalId,
    origin,
    text: decision.text,
    reference: null,
    reply: {
      kind: "slack",
      authority: decision.authority,
      ownerPrincipalId: decision.ownerPrincipalId,
      source: address,
    },
    dependencies: { sourceIds: [], toolIds: [] },
  });
};
