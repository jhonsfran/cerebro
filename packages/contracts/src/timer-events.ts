import { Schema } from "effect";

import { BotEventAddressSchema } from "./bot-events.ts";
import { WorkKeySchema } from "./work.ts";

const identifier = Schema.NonEmptyString.check(Schema.isMaxLength(512));
export const FixedReplyOriginSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("web") }),
  Schema.Struct({
    kind: Schema.Literal("slack-event"),
    source: BotEventAddressSchema,
    ownerPrincipalId: WorkKeySchema.fields.ownerPrincipalId,
    eventId: identifier,
  }),
]);
export type FixedReplyOrigin = typeof FixedReplyOriginSchema.Type;
