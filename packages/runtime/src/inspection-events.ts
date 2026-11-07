import type { EventAddress } from "@cerebro/contracts/events";
import { Denied } from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import type { InspectionEvent } from "@cerebro/contracts/inspection";
import type { ContentDependencies } from "@cerebro/contracts/session";
import { triggerActor } from "@cerebro/contracts/triggers";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";

import { sameWorkSource } from "./coordinator-ledger.ts";
import { piContext } from "./pi-harness.ts";
import { Replies } from "./replies.ts";
import type { Reply } from "./replies.ts";
import { Receipts } from "./trigger-receipts.ts";
import type { TriggerReceipt } from "./trigger-receipts.ts";
import { placementIn } from "./triggers.ts";
import type { TriggerPlacement } from "./triggers.ts";

const inspectReply = (
  record: Reply | null | undefined
): InspectionEvent["reply"] =>
  record
    ? {
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
  receipt: TriggerReceipt,
  placement: TriggerPlacement,
  record: Reply | null | undefined
): InspectionEvent => {
  const { trigger } = receipt;
  const recipients =
    receipt.route.kind === "teams" ? receipt.route.recipients : [];
  return {
    id: trigger.id,
    channel: trigger.origin.kind,
    actor: triggerActor(trigger.origin),
    route: receipt.route.kind,
    duplicates: receipt.duplicates,
    placement: placement.kind,
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
        Receipts,
        key,
        piContext(input.signal)
      );
      if (!saved?.receipt) {
        return null;
      }
      const { receipt } = saved;
      const { trigger } = receipt;
      if (!sameWorkSource(trigger.address, input.address)) {
        return null;
      }
      if (
        trigger.ownerPrincipalId !== input.ownerPrincipalId ||
        receipt.nativeId !== input.nativeId ||
        trigger.id !== key
      ) {
        throw new Denied({
          code: "unauthorized",
          reason: "The event belongs to another source.",
        });
      }
      const [placement, reply] = await Promise.all([
        input.pi.commit(
          (tx) => placementIn(tx, receipt),
          piContext(input.signal)
        ),
        input.pi.snapshot(Replies, trigger.id, piContext(input.signal)),
      ]);
      if (
        reply?.record &&
        (!sameWorkSource(reply.record.destination.source, input.address) ||
          reply.record.triggerId !== trigger.id)
      ) {
        throw new Denied({
          code: "unauthorized",
          reason: "The reply belongs to another source.",
        });
      }
      const dependencies: ContentDependencies[] = [trigger.dependencies];
      if (reply?.record) {
        dependencies.push(reply.record.dependencies);
      }
      return {
        item: inspectEvent(receipt, placement, reply?.record),
        dependencies,
      };
    })
  );
  return {
    items: results.flatMap((result) => (result ? [result.item] : [])),
    dependencies: results.flatMap((result) => result?.dependencies ?? []),
  };
};
