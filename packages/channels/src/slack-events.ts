import { z } from "zod";

import { assertQueuePayloadSize } from "./queue-payload";
import { ChannelError } from "./types";
import type { SlackConfiguration } from "./types";

const identifier = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value);
const eventSchema = z.object({
  bot_id: identifier.optional(),
  channel: identifier.optional(),
  channel_type: identifier.optional(),
  subtype: identifier.optional(),
  text: z.string().max(16_000).optional(),
  thread_ts: identifier.optional(),
  ts: identifier.optional(),
  type: identifier,
  user: identifier.optional(),
});

export const slackCallbackSchema = z.object({
  api_app_id: identifier,
  event: eventSchema,
  event_id: identifier,
  team_id: identifier,
  type: z.literal("event_callback"),
});

export const slackQueueDeliverySchema = z.strictObject({
  agentId: identifier,
  appId: identifier,
  event: eventSchema.strict(),
  eventId: identifier,
  organizationId: identifier,
  receivedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceRetry: z.boolean(),
  version: z.literal(1),
  workspaceId: identifier,
});
export type SlackQueueDelivery = z.infer<typeof slackQueueDeliverySchema>;

export const parseSlackQueueDelivery = (value: unknown): SlackQueueDelivery => {
  const parsed = slackQueueDeliverySchema.safeParse(value);
  if (!parsed.success) {
    throw new ChannelError(
      422,
      "invalid-input",
      "The saved Slack delivery is invalid."
    );
  }
  assertQueuePayloadSize(parsed.data);
  return parsed.data;
};

export const parseSlackCallback = (
  payload: unknown,
  configuration: SlackConfiguration
) => {
  const parsed = slackCallbackSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ChannelError(422, "invalid-input", "The Slack event is invalid.");
  }
  const callback = parsed.data;
  if (
    callback.api_app_id !== configuration.appId ||
    callback.team_id !== configuration.workspaceId
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "The Slack workspace or app is not configured."
    );
  }
  return callback;
};

export const normalizeSlackDelivery = (input: {
  readonly payload: unknown;
  readonly configuration: SlackConfiguration;
  readonly organizationId: string;
  readonly receivedAt: number;
  readonly sourceRetry: boolean;
}): SlackQueueDelivery => {
  const callback = parseSlackCallback(input.payload, input.configuration);
  return parseSlackQueueDelivery({
    agentId: input.configuration.agentId,
    appId: callback.api_app_id,
    event: callback.event,
    eventId: callback.event_id,
    organizationId: input.organizationId,
    receivedAt: input.receivedAt,
    sourceRetry: input.sourceRetry,
    version: 1,
    workspaceId: callback.team_id,
  });
};
