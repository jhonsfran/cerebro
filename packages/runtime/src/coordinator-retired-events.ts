import { InvalidInput } from "@cerebro/contracts/failures";
import { normalizeTeamCommand } from "@cerebro/contracts/team-events";
import {
  canonicalToolArguments,
  digestToolArguments,
} from "@cerebro/contracts/tools";
import type { Tx } from "@earendil-works/pi-durable";

import { BotEventReceipts, eventOf } from "./coordinator-event-state.ts";
import type { CoordinatorWorkRecord } from "./coordinator-ledger.ts";

export const discardQueuedCommandsIn = async (
  tx: Tx,
  record: CoordinatorWorkRecord,
  reason: "cancelled" | "expired"
): Promise<void> => {
  const admissionDigest = await digestToolArguments(record.admission);
  await Promise.all(
    Object.entries(record.queuedCommands).map(async ([commandId, input]) => {
      const { wire, command } = normalizeTeamCommand(input);
      if (wire.kind !== "event-command") {
        return;
      }
      const document = await tx.doc(BotEventReceipts, wire.event.id, null);
      const { receipt } = document;
      if (
        record.dispatched ||
        !receipt ||
        receipt.route.kind !== "teams" ||
        receipt.digest !== wire.event.digest ||
        receipt.digest !== (await digestToolArguments(receipt.input)) ||
        commandId !== command.id ||
        (await digestToolArguments(command.work)) !== admissionDigest
      ) {
        throw new InvalidInput({
          reason: "The queued event command changed before retirement.",
        });
      }
      const event = eventOf(receipt);
      const recipient = receipt.route.recipients.find(
        (item) => item.key.workId === record.admission.key.workId
      );
      if (
        !recipient ||
        recipient.commandId !== commandId ||
        recipient.admissionDigest !== admissionDigest ||
        event.ownerPrincipalId !== record.admission.key.ownerPrincipalId ||
        canonicalToolArguments(event.coordinator) !==
          canonicalToolArguments(record.admission.sourceEventAddress)
      ) {
        throw new InvalidInput({
          reason: "The queued event has no matching work recipient.",
        });
      }
      if (recipient.disposition.kind === "admitted") {
        recipient.disposition = { kind: "not-delivered", reason };
      } else if (
        recipient.disposition.kind !== "not-delivered" ||
        recipient.disposition.reason !== reason
      ) {
        throw new InvalidInput({
          reason: "The queued event already has another disposition.",
        });
      }
    })
  );
  record.queuedCommands = {};
};
