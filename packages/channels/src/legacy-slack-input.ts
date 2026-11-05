import type { EventAddress } from "@cerebro/contracts/events";
import { id } from "@cerebro/contracts/identity";
import type { Database } from "@cerebro/db";
import { channelSlackEventReceipt } from "@cerebro/db/schema/agents";
import { eq } from "drizzle-orm";

import { digest, contextByPrincipal } from "./security";
import {
  parseSlackEventDecision,
  readSlackEventTarget,
} from "./slack-event-receipts";
import { parseSlackCallback } from "./slack-events";
import { ChannelError } from "./types";
import type { ChannelOptions, SlackConfiguration } from "./types";

export const readAcceptedLegacySlackInput = async (input: {
  readonly database: Database;
  readonly configuration: SlackConfiguration;
  readonly address: EventAddress;
  readonly eventKey: string;
  readonly callback: unknown;
}) => {
  const callback = parseSlackCallback(input.callback, input.configuration);
  const eventKey = `slack:${input.address.organizationId}:${input.configuration.appId}:${input.configuration.workspaceId}:${callback.event_id}`;
  const [saved] = await input.database
    .select()
    .from(channelSlackEventReceipt)
    .where(eq(channelSlackEventReceipt.eventKey, input.eventKey));
  const decision = saved && parseSlackEventDecision(saved.decision);
  if (
    !saved ||
    !decision ||
    decision.kind !== "admit" ||
    input.eventKey !== eventKey ||
    saved.digest !==
      (await digest({ agentId: input.configuration.agentId, callback }))
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "This input has no matching accepted legacy Slack decision."
    );
  }
  const { event } = callback;
  if (!event.channel || !event.ts || !event.text || !event.user) {
    throw new ChannelError(
      403,
      "forbidden",
      "The accepted legacy Slack input is invalid."
    );
  }
  const conversation = await readSlackEventTarget(
    input.database,
    { organizationId: input.address.organizationId },
    input.configuration,
    decision,
    {
      channel: event.channel,
      ts: event.ts,
      text: event.text,
      user: event.user,
      threadTs: event.thread_ts,
    }
  );
  if (
    conversation.conversationId !== input.address.conversationId ||
    conversation.sessionId !== input.address.sessionId ||
    conversation.agentId !== input.address.agentId ||
    conversation.organizationId !== input.address.organizationId
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "The accepted legacy Slack address changed."
    );
  }
  return {
    conversation,
    ownerPrincipalId: decision.ownerPrincipalId,
    operationId: eventKey,
    text: event.text,
  };
};

export const receiveAcceptedLegacySlackInput = async (input: {
  readonly database: Database;
  readonly options: ChannelOptions;
  readonly configuration: SlackConfiguration;
  readonly eventKey: string;
  readonly callback: unknown;
}) => {
  const { database, options, configuration, eventKey, callback } = input;
  const [saved] = await database
    .select()
    .from(channelSlackEventReceipt)
    .where(eq(channelSlackEventReceipt.eventKey, eventKey));
  const decision = saved && parseSlackEventDecision(saved.decision);
  if (!decision || decision.kind !== "admit" || !options.slackEvents) {
    throw new ChannelError(
      503,
      "unavailable",
      "Legacy Slack admission is unavailable."
    );
  }
  const address = {
    organizationId: id.organization(decision.sourceEventAddress.organizationId),
    agentId: id.agent(decision.sourceEventAddress.agentId),
    conversationId: id.conversation(decision.sourceEventAddress.conversationId),
    sessionId: id.session(decision.sourceEventAddress.sessionId),
  };
  const accepted = await readAcceptedLegacySlackInput({
    database,
    configuration,
    address,
    eventKey,
    callback,
  });
  const context = await contextByPrincipal(
    database,
    options.organizationId,
    accepted.ownerPrincipalId
  );
  const receipt = await options.slackEvents.admitLegacy({
    address,
    context,
    eventKey,
    callback,
  });
  return { accepted: true, conversationId: address.conversationId, receipt };
};
