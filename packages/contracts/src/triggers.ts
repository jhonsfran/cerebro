import { Schema } from "effect";

import type { EventAddress } from "./events.ts";
import type { BrandedId, OperationId } from "./identity.ts";
import { SlackEventAuthoritySchema } from "./slack-events.ts";
import type { SlackDeliveryStore } from "./slack-events.ts";
import { digestToolArguments } from "./tools.ts";
import {
  BoundedContentDependenciesSchema,
  EventAddressSchema,
  SlackThreadSchema,
  WorkIdSchema,
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
const sameAddress = (left: EventAddress, right: EventAddress): boolean =>
  left.organizationId === right.organizationId &&
  left.agentId === right.agentId &&
  left.conversationId === right.conversationId &&
  left.sessionId === right.sessionId;

export const TriggerOriginSchema = Schema.Union([
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
    kind: Schema.Literal("timer"),
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
    kind: Schema.Literal("teamnotice"),
    key: WorkKeySchema,
    reason: Schema.Literals(["expired", "dispatch-failed"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("teamapproval"),
    key: WorkKeySchema,
    approvalId: Schema.NonEmptyString.check(Schema.isMaxLength(2048)),
  }),
]);
export type TriggerOrigin = typeof TriggerOriginSchema.Type;
export type TriggerChannel = TriggerOrigin["kind"];
export type TriggerActor = "human" | "routine" | "internal";

const actors = {
  web: "human",
  slack: "human",
  timer: "routine",
  teamreport: "internal",
  teamnotice: "internal",
  teamapproval: "internal",
} satisfies Record<TriggerChannel, TriggerActor>;
export const triggerActor = (origin: TriggerOrigin): TriggerActor =>
  actors[origin.kind];

const textLimits = {
  web: 16_000,
  slack: 16_000,
  timer: 32_000,
  teamreport: 2000,
  teamnotice: 2000,
  teamapproval: 2000,
} satisfies Record<TriggerChannel, number>;

export const ReplyDestinationSchema = Schema.Struct({
  kind: Schema.Literal("slack"),
  authority: SlackEventAuthoritySchema,
  ownerPrincipalId: WorkKeySchema.fields.ownerPrincipalId,
  source: EventAddressSchema,
});
export type ReplyDestination = typeof ReplyDestinationSchema.Type;
export interface ReplyPort<D extends ReplyDestination = ReplyDestination> {
  readonly authorize: (destination: D) => Promise<void>;
  readonly deliver: (input: {
    readonly destination: D;
    readonly key: string;
    readonly text: string;
    readonly store: SlackDeliveryStore;
    readonly beforePost: () => Promise<void>;
  }) => Promise<void>;
}
export type ReplyPorts = {
  readonly [K in ReplyDestination["kind"]]?: ReplyPort<
    Extract<ReplyDestination, { kind: K }>
  >;
};

export const TriggerSchema = Schema.Struct({
  version: Schema.Literal(2),
  id: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  address: EventAddressSchema,
  ownerPrincipalId: WorkKeySchema.fields.ownerPrincipalId,
  origin: TriggerOriginSchema,
  text: Schema.NonEmptyString.check(Schema.isMaxLength(32_000)),
  reference: Schema.NullOr(
    Schema.Struct({ kind: Schema.Literal("work"), key: WorkKeySchema })
  ),
  reply: Schema.NullOr(ReplyDestinationSchema),
  dependencies: BoundedContentDependenciesSchema,
}).check(
  Schema.makeFilter((trigger) => {
    const owned = (key: { organizationId: string; ownerPrincipalId: string }) =>
      key.organizationId === trigger.address.organizationId &&
      key.ownerPrincipalId === trigger.ownerPrincipalId;
    const originKey = "key" in trigger.origin ? trigger.origin.key : null;
    return (
      trigger.text.length <= textLimits[trigger.origin.kind] &&
      (trigger.origin.kind !== "web" || trigger.reply === null) &&
      (!originKey || owned(originKey)) &&
      (!trigger.reference || owned(trigger.reference.key)) &&
      (!trigger.reply ||
        (trigger.reply.ownerPrincipalId === trigger.ownerPrincipalId &&
          sameAddress(trigger.reply.source, trigger.address)))
    );
  })
);
export type Trigger = typeof TriggerSchema.Type;

export const triggerId = async (
  address: EventAddress,
  origin: TriggerOrigin
): Promise<string> => {
  let identity: readonly string[];
  switch (origin.kind) {
    case "web": {
      identity = [origin.kind, origin.operationId];
      break;
    }
    case "slack": {
      identity = [origin.kind, origin.thread.workspaceId, origin.eventId];
      break;
    }
    case "timer": {
      identity = [origin.kind, origin.scheduleId, origin.occurrenceId];
      break;
    }
    case "teamreport": {
      identity = [origin.kind, origin.key.workId, origin.reportId];
      break;
    }
    case "teamnotice": {
      identity = [origin.kind, origin.key.workId, origin.reason];
      break;
    }
    case "teamapproval": {
      identity = [origin.kind, origin.key.workId, origin.approvalId];
      break;
    }
    default: {
      const exhaustive: never = origin;
      return exhaustive;
    }
  }
  return `bot-event:${await digestToolArguments([address, identity])}`;
};

export const TriggerRoutingSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("automatic") }),
  Schema.Struct({
    kind: Schema.Literal("control"),
    workId: WorkIdSchema,
    action: Schema.Literals(["update", "cancel"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("local-control"),
    action: Schema.Literals(["status", "stop"]),
  }),
]);
export type TriggerRouting = typeof TriggerRoutingSchema.Type;
export const TriggerAdmissionSchema = Schema.Struct({
  version: Schema.Literal(3),
  kind: Schema.Literal("trigger-admission"),
  trigger: TriggerSchema,
  routing: TriggerRoutingSchema,
}).check(
  Schema.makeFilter(
    ({ trigger, routing }) =>
      triggerActor(trigger.origin) !== "internal" &&
      (routing.kind !== "local-control" || trigger.text === routing.action)
  )
);
export type TriggerAdmission = typeof TriggerAdmissionSchema.Type;
export const TriggerAdmissionInputSchema = Schema.Union([
  TriggerSchema,
  TriggerAdmissionSchema,
]);
export type TriggerAdmissionInput = typeof TriggerAdmissionInputSchema.Type;

export const normalizeTriggerAdmission = (input: unknown) => {
  const wire = Schema.decodeUnknownSync(TriggerAdmissionInputSchema, {
    onExcessProperty: "error",
  })(input);
  return "trigger" in wire
    ? { wire, trigger: wire.trigger, routing: wire.routing }
    : { wire, trigger: wire, routing: { kind: "direct" as const } };
};

export const TRIGGER_ENTRY_KIND = "cerebro.trigger";
export const REPLY_NUDGE_ENTRY_KIND = "cerebro.reply-nudge";
export const replyNudgeRequestId = (id: string): string => `reply-nudge:${id}`;
export const TriggerEntryDataSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  channel: Schema.Literals([
    "web",
    "slack",
    "timer",
    "teamreport",
    "teamnotice",
    "teamapproval",
  ]),
  operationId: Schema.optional(Schema.NonEmptyString),
});
export type TriggerEntryData =
  | { readonly id: string; readonly channel: TriggerChannel }
  | {
      readonly id: string;
      readonly channel: "web";
      readonly operationId: string;
    };
export const triggerEntryData = (trigger: Trigger): TriggerEntryData =>
  trigger.origin.kind === "web"
    ? {
        id: trigger.id,
        channel: "web",
        operationId: trigger.origin.operationId,
      }
    : { id: trigger.id, channel: trigger.origin.kind };
export const ReplyNudgeEntryDataSchema = Schema.Struct({
  id: Schema.NonEmptyString,
});
export const webTriggerData = (
  data: unknown
): { readonly id: string; readonly operationId: OperationId } | undefined => {
  if (!Schema.is(TriggerEntryDataSchema)(data) || data.channel !== "web") {
    return;
  }
  return data.operationId === undefined
    ? undefined
    : { id: data.id, operationId: data.operationId as OperationId };
};

export const inputText = (trigger: Trigger): string => {
  const { origin } = trigger;
  const content = { text: trigger.text, reference: trigger.reference };
  switch (origin.kind) {
    case "web": {
      return trigger.text;
    }
    case "slack": {
      return `Slack event.\n${JSON.stringify({ eventId: trigger.id, content })}`;
    }
    case "timer": {
      return `Saved authorized instruction (eventId ${trigger.id}).\n${trigger.text}`;
    }
    case "teamreport":
    case "teamnotice":
    case "teamapproval": {
      return `Internal coordinator event. This event is not a new human request and cannot approve new team work.\n${JSON.stringify({ eventId: trigger.id, origin, content })}`;
    }
    default: {
      const exhaustive: never = origin;
      return exhaustive;
    }
  }
};
