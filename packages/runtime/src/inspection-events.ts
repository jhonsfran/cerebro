import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, InvalidInput } from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import type { InspectionEvent } from "@cerebro/contracts/inspection";
import type { ContentDependencies } from "@cerebro/contracts/session";
import { digestToolArguments } from "@cerebro/contracts/tools";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";

import { BotEventReceipts, eventOf } from "./coordinator-event-state.ts";
import type { BotEventReceipt } from "./coordinator-event-state.ts";
import { sameWorkSource } from "./coordinator-ledger.ts";
import { CoordinatorReplies } from "./coordinator-replies.ts";
import type { CoordinatorReply } from "./coordinator-replies.ts";
import { piContext } from "./pi-harness.ts";

const inspectReply = (
  record: CoordinatorReply | null | undefined
): InspectionEvent["reply"] =>
  record
    ? {
        answerEntryId: String(record.answerEntryId),
        taskId: record.taskId === null ? null : String(record.taskId),
        state: record.delivery?.state ?? "pending",
        attempts: record.attempts,
        deadlineAt: record.until,
        retryAt:
          record.delivery?.state === "retry"
            ? (record.delivery.retryAt ?? null)
            : null,
        timestamp:
          record.delivery?.state === "sent" ? record.delivery.ts : null,
      }
    : null;
const inspectEvent = (
  receipt: BotEventReceipt,
  record: CoordinatorReply | null | undefined
): InspectionEvent => {
  const event = eventOf(receipt);
  const delivery =
    receipt.delivery.kind === "coordinator" ? receipt.delivery.admission : null;
  const recipients =
    receipt.route.kind === "teams" ? receipt.route.recipients : [];
  return {
    id: event.id,
    source: event.source.kind,
    route: receipt.route.kind,
    duplicates: receipt.duplicates,
    admission: delivery?.kind ?? "none",
    outcome: delivery?.kind === "settled" ? delivery.outcome : null,
    workIds: (receipt.route.kind === "control"
      ? [receipt.route.workId]
      : recipients.map((item) => item.key.workId)
    ).slice(0, 24),
    returns: recipients.slice(0, 24).map((item) => ({
      workId: item.key.workId,
      decision: item.disposition.kind,
    })),
    reply: inspectReply(record),
  };
};
export const readInspectionEvents = async (input: {
  readonly pi: Harness;
  readonly keys: readonly string[];
  readonly nativeId: ConversationId;
  readonly address: EventAddress;
  readonly ownerPrincipalId: PrincipalId;
  readonly signal?: AbortSignal;
}) => {
  const results = await Promise.all(
    input.keys.map(async (key) => {
      const saved = await input.pi.snapshot(
        BotEventReceipts,
        key,
        piContext(input.signal)
      );
      if (!saved?.receipt) {
        return null;
      }
      const { receipt } = saved;
      const event = eventOf(receipt);
      if (!sameWorkSource(event.coordinator, input.address)) {
        return null;
      }
      if (
        event.ownerPrincipalId !== input.ownerPrincipalId ||
        receipt.nativeId !== input.nativeId ||
        event.id !== key
      ) {
        throw new Denied({
          code: "unauthorized",
          reason: "The event belongs to another source.",
        });
      }
      if (receipt.digest !== (await digestToolArguments(receipt.input))) {
        throw new InvalidInput({ reason: "The saved event changed." });
      }
      const reply = await input.pi.snapshot(
        CoordinatorReplies,
        event.id,
        piContext(input.signal)
      );
      if (
        reply?.record &&
        (!sameWorkSource(reply.record.source, input.address) ||
          reply.record.eventId !== event.id)
      ) {
        throw new Denied({
          code: "unauthorized",
          reason: "The reply belongs to another source.",
        });
      }
      const dependencies: ContentDependencies[] = [event.dependencies];
      if (reply?.record) {
        dependencies.push(reply.record.dependencies);
      }
      return { item: inspectEvent(receipt, reply?.record), dependencies };
    })
  );
  return {
    items: results.flatMap((result) => (result ? [result.item] : [])),
    dependencies: results.flatMap((result) => result?.dependencies ?? []),
  };
};
