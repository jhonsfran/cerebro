import {
  BotEventSchema,
  BotEventAddressSchema,
} from "@cerebro/contracts/bot-events";
import type { BotEvent } from "@cerebro/contracts/bot-events";
import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, InvalidInput } from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import { SlackReplyDestinationSchema } from "@cerebro/contracts/slack-events";
import type { SlackReplyDestination } from "@cerebro/contracts/slack-events";
import { FixedReplyOriginSchema } from "@cerebro/contracts/timer-events";
import type {
  FixedReplyOrigin,
  LegacyTimerReplyOrigin,
} from "@cerebro/contracts/timer-events";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { defineDocFamily } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  JsonObject,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { BotEventReceipts, eventOf } from "./coordinator-event-state.ts";
import { sameWorkSource } from "./coordinator-ledger.ts";
import type { InstructionCause } from "./instruction-cause.ts";
import { piContext } from "./pi-harness.ts";

interface ReminderOrigin extends JsonObject {
  creatingEventId: string | null;
  reply: FixedReplyOrigin;
}
export const ReminderOrigins = defineDocFamily({
  kind: "cerebro.reminder-origin",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  version: 1,
  initial: (_seed: null): { record: ReminderOrigin | null } => ({
    record: null,
  }),
});
export interface SavedTimerOccurrence {
  readonly reminderId: string;
  readonly fingerprint: string;
  readonly occurrence: number;
  readonly instruction: string;
}
export interface TimerOccurrenceRecord extends JsonObject {
  source: { [Key in keyof EventAddress]: EventAddress[Key] };
  reminderId: string;
  fingerprint: string;
  occurrence: number;
  event: BotEvent;
  replyOrigin: FixedReplyOrigin;
  destination: SlackReplyDestination | null;
}
const timerOccurrenceSchema = Schema.Struct({
  source: BotEventAddressSchema,
  reminderId: Schema.String,
  fingerprint: Schema.String,
  occurrence: Schema.Number,
  event: BotEventSchema,
  replyOrigin: FixedReplyOriginSchema,
  destination: Schema.NullOr(SlackReplyDestinationSchema),
});
export const copyTimerOccurrence = (
  record: TimerOccurrenceRecord
): TimerOccurrenceRecord =>
  Schema.decodeUnknownSync(Schema.fromJsonString(timerOccurrenceSchema), {
    onExcessProperty: "error",
  })(JSON.stringify(record));
export const TimerOccurrences = defineDocFamily({
  kind: "cerebro.timer-occurrence",
  scope: "session",
  family: true,
  version: 1,
  initial: (_seed: null): { record: TimerOccurrenceRecord | null } => ({
    record: null,
  }),
});

export const saveReminderOriginIn = async (
  tx: Tx,
  input: {
    readonly nativeId: ConversationId;
    readonly reminderId: string;
    readonly address: EventAddress;
    readonly ownerPrincipalId: PrincipalId;
    readonly cause?: InstructionCause;
    readonly legacy?: LegacyTimerReplyOrigin;
  }
): Promise<void> => {
  const saved = await tx.doc(
    ReminderOrigins,
    input.nativeId,
    input.reminderId,
    null
  );
  if (saved.record) {
    return;
  }
  let reply: FixedReplyOrigin = input.legacy ?? { kind: "web" };
  if (input.cause?.eventId) {
    const original = await tx.doc(BotEventReceipts, input.cause.eventId, null);
    if (!original.receipt) {
      throw new InvalidInput({ reason: "The schedule origin is unavailable." });
    }
    const event = eventOf(original.receipt);
    if (
      event.ownerPrincipalId !== input.ownerPrincipalId ||
      !sameWorkSource(event.coordinator, input.address)
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "The schedule origin belongs to another source.",
      });
    }
    reply = { kind: "web" };
    if (event.source.kind === "slack") {
      reply = {
        kind: "slack-event",
        source: event.coordinator,
        ownerPrincipalId: event.ownerPrincipalId,
        eventId: event.id,
      };
    } else if (event.source.kind === "savedtimer") {
      const occurrence = await tx.doc(TimerOccurrences, event.id, null);
      if (
        occurrence.record &&
        canonicalToolArguments(occurrence.record.event) ===
          canonicalToolArguments(event)
      ) {
        reply = occurrence.record.replyOrigin;
      }
    }
  }
  saved.record = { creatingEventId: input.cause?.eventId ?? null, reply };
};

export const resolveFixedReplyOrigin = async (
  pi: Harness,
  origin: FixedReplyOrigin
): Promise<BotEvent | LegacyTimerReplyOrigin | null> => {
  if (origin.kind === "web") {
    return null;
  }
  if (origin.kind === "legacy-slack-timer") {
    return origin;
  }
  const original = await pi.snapshot(
    BotEventReceipts,
    origin.eventId,
    piContext()
  );
  const event = original?.receipt && eventOf(original.receipt);
  if (
    !event ||
    event.source.kind !== "slack" ||
    event.ownerPrincipalId !== origin.ownerPrincipalId ||
    !sameWorkSource(event.coordinator, origin.source)
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The timer reply origin changed.",
    });
  }
  return event;
};

export const timerReplyDestination = async (
  pi: Harness,
  event: BotEvent
): Promise<SlackReplyDestination | null> => {
  if (event.source.kind !== "savedtimer") {
    return null;
  }
  const saved = await pi.snapshot(TimerOccurrences, event.id, piContext());
  if (!saved?.record) {
    return null;
  }
  if (
    canonicalToolArguments(saved.record.event) !== canonicalToolArguments(event)
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The saved timer occurrence changed.",
    });
  }
  return saved.record.destination;
};
