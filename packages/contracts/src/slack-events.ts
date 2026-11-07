import { Schema } from "effect";

import {
  EventAddressSchema,
  WorkKeySchema,
  SlackThreadSchema,
} from "./work.ts";

const identifier = Schema.NonEmptyString.check(Schema.isMaxLength(512));
export const SlackEventAuthoritySchema = Schema.Struct({
  appId: identifier,
  eventId: identifier,
  userId: identifier,
  thread: SlackThreadSchema,
});
export type SlackEventAuthority = typeof SlackEventAuthoritySchema.Type;
export const SlackPrimaryDecisionSchema = Schema.Struct({
  kind: Schema.Literal("primary-events-v2"),
  ownerPrincipalId: WorkKeySchema.fields.ownerPrincipalId,
  authority: SlackEventAuthoritySchema,
  text: Schema.NonEmptyString.check(Schema.isMaxLength(16_000)),
  targets: Schema.Array(EventAddressSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(18)
  ),
});
export type SlackPrimaryDecision = typeof SlackPrimaryDecisionSchema.Type;
export type SlackDelivery =
  | { readonly state: "sent"; readonly text: string; readonly ts: string }
  | { readonly state: "unknown" | "failed"; readonly text: string }
  | {
      readonly state: "retry";
      readonly text: string;
      readonly retryAt?: number;
    }
  | {
      readonly state: "blocked";
      readonly text: string;
      readonly reason: "access-changed" | "cancelled";
    };
export interface SlackDeliveryStore {
  readonly get: (key: string) => Promise<SlackDelivery | undefined>;
  readonly set: (key: string, delivery: SlackDelivery) => Promise<void>;
}
export const SlackEventReferenceSchema = Schema.Struct({
  eventKey: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
});
