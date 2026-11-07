import {
  primarySlackBotEvent,
  readSlackPrimaryEvent,
} from "../../packages/channels/src/slack-primary-events";
import type { ChannelOptions } from "../../packages/channels/src/types";
import { id } from "../../packages/contracts/src/identity";
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
