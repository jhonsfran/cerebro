import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, InvalidInput } from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import type { ReplyDestination } from "@cerebro/contracts/triggers";
import { defineDocFamily } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  JsonObject,
  Tx,
} from "@earendil-works/pi-durable";

import { sameWorkSource } from "./coordinator-ledger.ts";
import type { InstructionCause } from "./instruction-cause.ts";
import { Receipts } from "./trigger-receipts.ts";

interface ReminderOrigin extends JsonObject {
  creatingEventId: string | null;
  reply: ReplyDestination | null;
}
export const ReminderOrigins = defineDocFamily({
  kind: "cerebro.reminder-origin",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  version: 2,
  migrate: (): { record: ReminderOrigin | null } => {
    throw new Error("Unsupported reminder origin version.");
  },
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

/** A schedule answers where its cause did: the destination is copied from the cause trigger's receipt. */
export const saveReminderOriginIn = async (
  tx: Tx,
  input: {
    readonly nativeId: ConversationId;
    readonly reminderId: string;
    readonly address: EventAddress;
    readonly ownerPrincipalId: PrincipalId;
    readonly cause?: InstructionCause;
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
  let reply: ReplyDestination | null = null;
  if (input.cause) {
    const original = await tx.doc(Receipts, input.cause.eventId, null);
    const trigger = original.receipt?.trigger;
    if (!trigger) {
      throw new InvalidInput({ reason: "The schedule origin is unavailable." });
    }
    if (
      trigger.ownerPrincipalId !== input.ownerPrincipalId ||
      !sameWorkSource(trigger.address, input.address)
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "The schedule origin belongs to another source.",
      });
    }
    ({ reply } = trigger);
  }
  saved.record = { creatingEventId: input.cause?.eventId ?? null, reply };
};
