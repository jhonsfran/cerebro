import { InvalidInput } from "@cerebro/contracts/failures";
import type { ContentDependencies } from "@cerebro/contracts/session";
import { normalizeTeamCommand } from "@cerebro/contracts/team-events";
import type {
  TeamCommandTransport,
  TeamEventCommand,
} from "@cerebro/contracts/team-events";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { TeamCommandSchema } from "@cerebro/contracts/work";
import type {
  BackgroundWorkSnapshot,
  TeamCommand,
} from "@cerebro/contracts/work";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { Schema } from "effect";

import type { createCoordinatorDispatch } from "./coordinator-dispatch.ts";
import {
  CommandReceipts,
  SourceOperations,
  WorkLedger,
  coordinatorOperationKey,
  requireCoordinatorWork,
  retainTerminalWorkIn,
  workHoldsSlot,
  workAcceptsEvents,
} from "./coordinator-ledger.ts";
import type {
  CoordinationBinding,
  CoordinatorWorkRecord,
} from "./coordinator-ledger.ts";
import { discardQueuedCommandsIn } from "./coordinator-retired-events.ts";
import type { EventRecipient, EventSkip } from "./trigger-receipts.ts";

type CoordinatorInput =
  | { readonly kind: "cancel" }
  | {
      readonly kind: "input";
      readonly text: string;
      readonly contentDependencies: ContentDependencies;
    };
const matchesCommandInput = (
  saved: TeamCommand,
  input: CoordinatorInput
): boolean =>
  saved.kind === input.kind &&
  (saved.kind !== "input" ||
    input.kind !== "input" ||
    saved.text === input.text);
export const canCancelWork = (
  record: CoordinatorWorkRecord,
  time: number
): boolean =>
  (workHoldsSlot(record, time) ||
    (record.status.kind === "queued" && record.admission.deadlineAt > time)) &&
  record.status.kind !== "cancelled" &&
  record.status.kind !== "completed";
const acceptsCommands = (record: CoordinatorWorkRecord): boolean =>
  record.reportId === null &&
  (record.status.kind === "accepted" || record.status.kind === "running");

const bufferIn = async (
  tx: Tx,
  record: CoordinatorWorkRecord,
  transport: TeamCommandTransport
): Promise<void> => {
  const { command } = normalizeTeamCommand(transport);
  if (command.kind === "cancel") {
    await discardQueuedCommandsIn(tx, record, "cancelled");
    record.status = { kind: "cancelled", commandId: command.id };
    await retainTerminalWorkIn(tx, record);
    const ledger = await tx.doc(WorkLedger);
    ledger.queue = ledger.queue.filter(
      (entry) => entry.workId !== record.admission.key.workId
    );
    return;
  }
  const bufferedCommands = record.queuedCommands;
  if (Object.keys(bufferedCommands).length >= 6) {
    throw new InvalidInput({
      reason: "This queued work already has its maximum pending updates.",
    });
  }
  bufferedCommands[command.id] = transport;
  record.queuedCommands = bufferedCommands;
};

const prunePendingIn = async (
  tx: Tx,
  records: readonly CoordinatorWorkRecord[]
) => {
  await Promise.all(
    records.map(async (record) => {
      const pending = await Promise.all(
        Object.entries(record.pendingCommands).map(
          async ([commandId, receipt]) => ({
            commandId,
            task: await tx.task(receipt.taskId),
          })
        )
      );
      for (const item of pending) {
        if (!item.task || item.task.state.status === "terminal") {
          Reflect.deleteProperty(record.pendingCommands, item.commandId);
        }
      }
    })
  );
};
export const createCoordinatorCommands = (options: {
  readonly nativeId: ConversationId;
  readonly dispatch: ReturnType<typeof createCoordinatorDispatch>;
  readonly binding: () => CoordinationBinding;
  readonly now: () => number;
  readonly publicWork: (
    record: CoordinatorWorkRecord
  ) => BackgroundWorkSnapshot;
}) => {
  const { dispatch, binding, now, publicWork } = options;
  const commandReceipt = async (tx: Tx, transport: TeamCommandTransport) => {
    const { command, wire } = normalizeTeamCommand(transport);
    const digest = await coordinatorOperationKey(JSON.stringify(wire));
    const document = await tx.doc(CommandReceipts, command.id, null);
    if (!document.receipt) {
      return { digest, document, taskId: undefined };
    }
    const task = await tx.task(document.receipt.taskId);
    if (
      !task ||
      task.kind !== dispatch.definition.name ||
      document.receipt.digest !== digest
    ) {
      throw new InvalidInput({
        reason: "The team command ID names another input.",
      });
    }
    const saved = normalizeTeamCommand(task.input);
    if (
      (await coordinatorOperationKey(JSON.stringify(saved.wire))) !== digest
    ) {
      throw new InvalidInput({ reason: "The saved team command changed." });
    }
    return { digest, document, taskId: document.receipt.taskId };
  };
  const enqueueAllIn = async (
    tx: Tx,
    items: readonly {
      readonly record: CoordinatorWorkRecord;
      readonly command: TeamCommandTransport;
    }[]
  ): Promise<void> => {
    const prepared = await Promise.all(
      items.map(async (item) => ({
        ...item,
        previous: await commandReceipt(tx, item.command),
      }))
    );
    const records = [...new Set(items.map((item) => item.record))];
    await prunePendingIn(tx, records);
    for (const { record, command, previous } of prepared) {
      const normalized = normalizeTeamCommand(command).command;
      if (previous.taskId !== undefined) {
        continue;
      }
      const limit = normalized.kind === "cancel" ? 8 : 7;
      if (Object.keys(record.pendingCommands).length >= limit) {
        throw new InvalidInput({
          reason: "This work already has its maximum pending commands.",
        });
      }
      // oxlint-disable-next-line no-await-in-loop -- Read all receipts and task states before the first Pi table write.
      const taskId = await tx.createTask(dispatch, command, {
        background: true,
        conversationId: options.nativeId,
        ownership: { kind: "conversation" },
      });
      const receipt = { digest: previous.digest, taskId };
      previous.document.receipt = receipt;
      record.pendingCommands[normalized.id] = receipt;
    }
  };
  const enqueueIn = async (
    tx: Tx,
    record: CoordinatorWorkRecord,
    command: TeamCommandTransport
  ): Promise<void> => {
    await enqueueAllIn(tx, [{ record, command }]);
  };
  const alreadyAccepted = async (
    tx: Tx,
    record: CoordinatorWorkRecord,
    commandId: string,
    input: CoordinatorInput
  ): Promise<boolean> => {
    const buffered = record.queuedCommands[commandId];
    if (buffered) {
      if (!matchesCommandInput(normalizeTeamCommand(buffered).command, input)) {
        throw new InvalidInput({
          reason: "The team command ID names another input.",
        });
      }
      return true;
    }
    const receipt = await tx.doc(CommandReceipts, commandId, null);
    if (receipt.receipt) {
      const task = await tx.task(receipt.receipt.taskId);
      const saved = task ? normalizeTeamCommand(task.input).command : undefined;
      if (
        !saved ||
        saved.id !== commandId ||
        !matchesCommandInput(saved, input) ||
        JSON.stringify(saved.work) !== JSON.stringify(record.admission)
      ) {
        throw new InvalidInput({
          reason: "The team command ID names another input.",
        });
      }
      await commandReceipt(tx, saved);
      return true;
    }
    return false;
  };
  const commandIn = async (
    tx: Tx,
    workId: string,
    operationId: string,
    input: CoordinatorInput,
    origin: "human" | "tool" = "human"
  ) => {
    const { kind } = input;
    const suffix = await coordinatorOperationKey(
      JSON.stringify([origin, operationId])
    );
    const commandId =
      kind === "cancel" ? `cancel:${workId}` : `input:${workId}:${suffix}`;
    const operation =
      origin === "human"
        ? await tx.doc(
            SourceOperations,
            options.nativeId,
            await coordinatorOperationKey(operationId),
            operationId
          )
        : undefined;
    if (operation?.route) {
      const expected = JSON.stringify({ kind: "team", workId, commandId });
      if (JSON.stringify(operation.route) !== expected) {
        throw new InvalidInput({
          reason: "The source operation already chose another route.",
        });
      }
    }
    const record = await requireCoordinatorWork(tx, binding(), workId);
    if (operation) {
      operation.route = { kind: "team", workId, commandId };
    }
    if (await alreadyAccepted(tx, record, commandId, input)) {
      return { ...publicWork(record), accepted: false };
    }
    const command = Schema.decodeUnknownSync(TeamCommandSchema, {
      onExcessProperty: "error",
    })({
      id: commandId,
      work: record.admission,
      ...input,
    });
    if (
      record.status.kind === "queued" &&
      record.admission.deadlineAt > now()
    ) {
      await bufferIn(tx, record, command);
      return { ...publicWork(record), accepted: true };
    }
    if (kind === "cancel") {
      if (!canCancelWork(record, now())) {
        return { ...publicWork(record), accepted: false };
      }
      record.status = {
        kind: "cancelled",
        commandId: command.id,
      };
      await retainTerminalWorkIn(tx, record);
    } else if (!workHoldsSlot(record, now()) || !acceptsCommands(record)) {
      throw new InvalidInput({ reason: "This work no longer accepts input." });
    }
    await enqueueIn(tx, record, command);
    return { ...publicWork(record), accepted: true };
  };

  const eventCommandsIn = async (
    tx: Tx,
    items: readonly {
      record: CoordinatorWorkRecord;
      command: TeamEventCommand;
    }[]
  ): Promise<{ recipients: EventRecipient[]; skipped: EventSkip[] }> => {
    await prunePendingIn(
      tx,
      items.map(({ record }) => record)
    );
    const recipients: EventRecipient[] = [];
    const skipped: EventSkip[] = [];
    const active: {
      record: CoordinatorWorkRecord;
      command: TeamEventCommand;
    }[] = [];
    const queuedItems: typeof active = [];
    const prepared = await Promise.all(
      items.map(async (item) => ({
        ...item,
        digest: await digestToolArguments(item.record.admission),
      }))
    );
    for (const item of prepared) {
      const { record, command } = item;
      const { workId } = record.admission.key;
      const queued =
        record.status.kind === "queued" && record.admission.deadlineAt > now();
      if (!workAcceptsEvents(record, now())) {
        skipped.push({ workId, reason: "terminal" });
        continue;
      }
      const full = queued
        ? Object.keys(record.queuedCommands).length >= 6
        : Object.keys(record.pendingCommands).length >= 7;
      if (full) {
        skipped.push({ workId, reason: "full" });
        continue;
      }
      recipients.push({
        key: record.admission.key,
        admissionDigest: item.digest,
        commandId: command.command.id,
        disposition: { kind: "admitted" },
      });
      if (queued) {
        queuedItems.push(item);
      } else {
        active.push(item);
      }
    }
    await Promise.all(
      queuedItems.map(({ record, command }) => bufferIn(tx, record, command))
    );
    await enqueueAllIn(tx, active);
    return { recipients, skipped };
  };
  return { commandIn, enqueueIn, enqueueAllIn, eventCommandsIn };
};
