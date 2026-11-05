import { digest } from "../../packages/channels/src/security";
import { parseSlackCallback } from "../../packages/channels/src/slack-events";
import {
  primarySlackBotEvent,
  readSlackPrimaryEvent,
} from "../../packages/channels/src/slack-primary-events";
import type { ChannelOptions } from "../../packages/channels/src/types";
import { id } from "../../packages/contracts/src/identity";
import {
  channelConversation,
  channelSlackEventReceipt,
} from "../../packages/db/src/schema/agents";
import { hideFixtureEvent } from "./fixture-session";

export const createFixtureSlackEvents = (
  getOptions: () => ChannelOptions
): NonNullable<ChannelOptions["slackEvents"]> => ({
  discover: () => Promise.resolve([]),
  admit: ({ address, context, eventKey }) =>
    getOptions().withDatabase(async (database) => {
      const options = getOptions();
      if (!options.slack) {
        throw new Error("The fixture Slack configuration is missing.");
      }
      const { decision } = await readSlackPrimaryEvent({
        database,
        configuration: options.slack,
        address,
        eventKey,
      });
      const event = await primarySlackBotEvent(decision, address);
      hideFixtureEvent(event.id);
      await options.sessions(database).send({
        address,
        context,
        operationId: id.operation(event.id),
        text: event.content.text,
      });
      return { eventId: event.id };
    }),
});

export const saveLegacySlackDecision = async (
  options: ChannelOptions,
  payload: unknown,
  principalId: string
) => {
  if (!options.slack) {
    throw new Error("The fixture Slack configuration is missing.");
  }
  const configuration = options.slack;
  const callback = parseSlackCallback(payload, configuration);
  const { event } = callback;
  const rootTimestamp = event.thread_ts ?? event.ts;
  if (!rootTimestamp || !event.channel || !event.user) {
    throw new Error("The legacy fixture requires a Slack message.");
  }
  const bindingKey = `pi-identity-v1:slack:${await digest({ agentId: configuration.agentId, channelId: event.channel, organizationId: options.organizationId, principalId, rootTimestamp, userId: event.user, workspaceId: configuration.workspaceId })}`;
  const conversationId = `conversation:${await digest(bindingKey)}`;
  const sessionId = `session:${await digest({ agentId: configuration.agentId, conversationId, organizationId: options.organizationId })}`;
  const eventKey = `slack:${options.organizationId}:${configuration.appId}:${configuration.workspaceId}:${callback.event_id}`;
  const address = {
    agentId: configuration.agentId,
    conversationId,
    organizationId: options.organizationId,
    sessionId,
  };
  await options.withDatabase(async (database) => {
    await database.insert(channelConversation).values({
      ...address,
      bindingKey,
      channelId: event.channel,
      rootTimestamp,
      ownerPrincipalId: principalId,
      kind: "slack",
      engine: "pi-identity-v1",
      slackUserId: event.user,
      workspaceId: configuration.workspaceId,
    });
    await database.insert(channelSlackEventReceipt).values({
      eventKey,
      digest: await digest({ agentId: configuration.agentId, callback }),
      decision: {
        kind: "admit",
        ownerPrincipalId: principalId,
        sourceEventAddress: address,
      },
    });
  });
  return { address, eventKey };
};
