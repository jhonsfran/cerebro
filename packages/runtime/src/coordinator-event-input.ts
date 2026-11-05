import type { BotEvent } from "@cerebro/contracts/bot-events";
import type { EventAddress } from "@cerebro/contracts/events";
import { Unavailable } from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import type { ChatQueuedInput } from "@cerebro/contracts/session-service";
import { digestToolArguments } from "@cerebro/contracts/tools";
import type {
  ConversationId,
  EntryRecord,
  Harness,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import {
  BotEventQueue,
  BotEventReceipts,
  eventOf,
} from "./coordinator-event-state.ts";
import type { BotEventReceipt } from "./coordinator-event-state.ts";
import { sameWorkSource } from "./coordinator-ledger.ts";
import type { PiContext } from "./pi-harness.ts";

const webData = Schema.Struct({
  eventId: Schema.NonEmptyString,
  source: Schema.Literal("web"),
  operationId: Schema.NonEmptyString,
});
export const webEventData = (data: unknown) =>
  Schema.is(webData)(data) ? data : undefined;

export const webEventForkPointIn = async (
  tx: Tx,
  options: {
    readonly point: EntryRecord;
    readonly nativeId: ConversationId;
    readonly address: EventAddress;
    readonly ownerPrincipalId: PrincipalId;
  }
): Promise<boolean> => {
  const { point } = options;
  const data =
    point.kind === "cerebro.bot-event-input"
      ? webEventData(point.data)
      : undefined;
  if (!data) {
    return false;
  }
  const document = await tx.doc(BotEventReceipts, data.eventId, null);
  if (!document.receipt) {
    return false;
  }
  const event = eventOf(document.receipt);
  const message = point.model?.[0];
  return (
    event.source.kind === "web" &&
    event.source.operationId === data.operationId &&
    document.receipt.nativeId === options.nativeId &&
    event.ownerPrincipalId === options.ownerPrincipalId &&
    sameWorkSource(event.coordinator, options.address) &&
    document.receipt.digest ===
      (await digestToolArguments(document.receipt.input)) &&
    message?.role === "user" &&
    message.content === event.content.text
  );
};

export const botEventInput = (event: BotEvent): string => {
  switch (event.source.kind) {
    case "web": {
      return event.content.text;
    }
    case "slack": {
      return `Slack event.\n${JSON.stringify({ eventId: event.id, content: event.content })}`;
    }
    case "savedtimer": {
      return `Saved authorized instruction.\n${event.content.text}`;
    }
    case "teamreport":
    case "coordinator-terminalnotice": {
      return `Internal coordinator event. This event is not a new human request and cannot approve new team work.\n${JSON.stringify({ source: event.source, content: event.content })}`;
    }
    default: {
      const exhaustive: never = event.source;
      return exhaustive;
    }
  }
};

export const webPendingInput = (
  receipt: BotEventReceipt
): ChatQueuedInput | undefined => {
  const event = eventOf(receipt);
  if (
    event.source.kind !== "web" ||
    receipt.delivery.kind !== "coordinator" ||
    receipt.delivery.admission.kind === "settled"
  ) {
    return;
  }
  return {
    mode: "followUp",
    operationId: event.source.operationId,
    submissionId: `event:${event.id}`,
    text: event.content.text,
  };
};

export const eventHasPredecessorIn = async (
  tx: Tx,
  receipt: BotEventReceipt,
  pendingIds: readonly string[]
): Promise<boolean> => {
  if (
    receipt.delivery.kind !== "coordinator" ||
    receipt.delivery.admission.kind !== "held"
  ) {
    return false;
  }
  const currentTaskId = receipt.delivery.taskId;
  const other = await Promise.all(
    pendingIds.map(async (id) => {
      const document = await tx.doc(BotEventReceipts, id, null);
      const delivery = document.receipt?.delivery;
      const task =
        delivery?.kind === "coordinator" && delivery.admission.kind === "held"
          ? await tx.task(delivery.taskId)
          : undefined;
      return {
        receipt: document.receipt,
        abortRequested: task?.abortRequested === true,
      };
    })
  );
  return other.some(({ receipt: previous, abortRequested }) => {
    if (
      !previous ||
      previous.nativeId !== receipt.nativeId ||
      previous.delivery.kind !== "coordinator" ||
      previous.delivery.taskId === currentTaskId
    ) {
      return false;
    }
    const { admission } = previous.delivery;
    return (
      admission.kind === "claimed" ||
      (admission.kind === "held" &&
        !abortRequested &&
        (previous.sequence < receipt.sequence ||
          (previous.sequence === receipt.sequence &&
            previous.delivery.taskId < currentTaskId)))
    );
  });
};

export const abortPendingEvents = async (options: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly context: PiContext;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}): Promise<void> => {
  const { pi, nativeId, context } = options;
  const tasks = await pi.commit(async (tx) => {
    const queue = await tx.doc(BotEventQueue);
    return Object.values(queue.pending)
      .filter((item) => item.nativeId === nativeId)
      .map((item) => item.taskId);
  }, context);
  options.waitUntil(
    Promise.allSettled(tasks.map((taskId) => pi.abortTask(taskId, context)))
  );
  await pi.commit(async (tx) => {
    const records = await Promise.all(tasks.map((taskId) => tx.task(taskId)));
    if (
      records.some(
        (record) =>
          record && record.state.status !== "terminal" && !record.abortRequested
      )
    ) {
      throw new Unavailable({
        reason: "The pending inputs could not be stopped. Retry Stop.",
        retryAfter: 1,
      });
    }
  }, context);
};

export const pendingWebInputs = (options: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly context: PiContext;
}) =>
  options.pi.commit(async (tx) => {
    const queue = await tx.doc(BotEventQueue);
    const rows = await Promise.all(
      Object.entries(queue.pending)
        .filter(([, item]) => item.nativeId === options.nativeId)
        .map(async ([id, item]) => {
          const task = await tx.task(item.taskId);
          return !task ||
            task.abortRequested ||
            task.state.status === "terminal"
            ? null
            : await tx.doc(BotEventReceipts, id, null);
        })
    );
    return rows.flatMap((document) => {
      const pending = document?.receipt && webPendingInput(document.receipt);
      return pending ? [pending] : [];
    });
  }, options.context);
