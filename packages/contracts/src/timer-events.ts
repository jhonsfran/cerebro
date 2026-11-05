import { Schema } from "effect";

import { BotEventAddressSchema } from "./bot-events.ts";
import { SlackThreadSchema, WorkKeySchema } from "./work.ts";

const identifier = Schema.NonEmptyString.check(Schema.isMaxLength(512));
export const LegacyTimerReplyOriginSchema = Schema.Struct({
  kind: Schema.Literal("legacy-slack-timer"),
  source: BotEventAddressSchema,
  ownerPrincipalId: WorkKeySchema.fields.ownerPrincipalId,
  authority: Schema.Struct({
    appId: identifier,
    userId: identifier,
    thread: SlackThreadSchema,
  }),
});
export type LegacyTimerReplyOrigin = typeof LegacyTimerReplyOriginSchema.Type;
export const FixedReplyOriginSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("web") }),
  Schema.Struct({
    kind: Schema.Literal("slack-event"),
    source: BotEventAddressSchema,
    ownerPrincipalId: WorkKeySchema.fields.ownerPrincipalId,
    eventId: identifier,
  }),
  LegacyTimerReplyOriginSchema,
]);
export type FixedReplyOrigin = typeof FixedReplyOriginSchema.Type;
