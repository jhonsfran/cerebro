import { Schema } from "effect";

import type { EventAddress } from "./events.ts";
import type { BrandedId } from "./identity.ts";
import { digestToolArguments } from "./tools.ts";
import {
  BoundedContentDependenciesSchema,
  AgentPinSchema,
  SlackThreadSchema,
  WorkKeySchema,
  WorkReportIdSchema,
} from "./work.ts";

const identifier = <Name extends string>() =>
  Schema.declare<BrandedId<Name>>(
    (value): value is BrandedId<Name> =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      value.trim() === value
  );
export const BotEventAddressSchema = Schema.Struct({
  organizationId: WorkKeySchema.fields.organizationId,
  agentId: AgentPinSchema.fields.agentId,
  conversationId: identifier<"ConversationId">(),
  sessionId: identifier<"SessionId">(),
}) satisfies Schema.Codec<EventAddress>;
export const BotEventSourceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("web"),
    operationId: identifier<"OperationId">(),
  }),
  Schema.Struct({
    kind: Schema.Literal("slack"),
    eventId: identifier<"SlackEventId">(),
    thread: SlackThreadSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("savedtimer"),
    scheduleId: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
    occurrenceId: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  }),
  Schema.Struct({
    kind: Schema.Literal("teamreport"),
    key: WorkKeySchema,
    reportId: WorkReportIdSchema,
    outcome: Schema.Literals(["completed", "failed", "cancelled"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("coordinator-terminalnotice"),
    key: WorkKeySchema,
    reason: Schema.Literals(["expired", "dispatch-failed"]),
  }),
]);
const eventTextLimits = {
  web: 16_000,
  slack: 16_000,
  savedtimer: 32_000,
  teamreport: 2000,
  "coordinator-terminalnotice": 2000,
} satisfies Record<(typeof BotEventSourceSchema.Type)["kind"], number>;
export const BotEventSchema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  coordinator: BotEventAddressSchema,
  ownerPrincipalId: WorkKeySchema.fields.ownerPrincipalId,
  source: BotEventSourceSchema,
  replyTo: Schema.NullOr(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("web"),
        address: BotEventAddressSchema,
      }),
      Schema.Struct({
        kind: Schema.Literal("slack"),
        thread: SlackThreadSchema,
      }),
    ])
  ),
  content: Schema.Struct({
    text: Schema.NonEmptyString.check(Schema.isMaxLength(32_000)),
    reference: Schema.NullOr(
      Schema.Struct({
        kind: Schema.Literal("work"),
        key: WorkKeySchema,
      })
    ),
  }),
  dependencies: BoundedContentDependenciesSchema,
}).check(
  Schema.makeFilter((event) => {
    const key = "key" in event.source ? event.source.key : null;
    const reference = event.content.reference?.key;
    return (
      event.content.text.length <= eventTextLimits[event.source.kind] &&
      (!key ||
        (key.organizationId === event.coordinator.organizationId &&
          key.ownerPrincipalId === event.ownerPrincipalId)) &&
      (!reference ||
        (reference.organizationId === event.coordinator.organizationId &&
          reference.ownerPrincipalId === event.ownerPrincipalId))
    );
  })
);
export type BotEvent = typeof BotEventSchema.Type;

export const botEventId = async (
  coordinator: EventAddress,
  source: BotEvent["source"]
): Promise<string> => {
  let identity: readonly string[];
  switch (source.kind) {
    case "web": {
      identity = [source.kind, source.operationId];
      break;
    }
    case "slack": {
      identity = [source.kind, source.thread.workspaceId, source.eventId];
      break;
    }
    case "savedtimer": {
      identity = [source.kind, source.scheduleId, source.occurrenceId];
      break;
    }
    case "teamreport": {
      identity = [source.kind, source.key.workId, source.reportId];
      break;
    }
    case "coordinator-terminalnotice": {
      identity = [source.kind, source.key.workId, source.reason];
      break;
    }
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
  return `bot-event:${await digestToolArguments([coordinator, identity])}`;
};
