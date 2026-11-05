import { InvalidInput } from "@cerebro/contracts/failures";
import type { ContentDependencies } from "@cerebro/contracts/session";
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
  workHoldsSlot,
} from "./coordinator-ledger.ts";
import type {
  CoordinationBinding,
  CoordinatorWorkRecord,
} from "./coordinator-ledger.ts";

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
  command: TeamCommand
): Promise<void> => {
  if (command.kind === "cancel") {
    record.status = { kind: "cancelled", commandId: command.id };
    record.queuedCommands = {};
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
  bufferedCommands[command.id] = command;
  record.queuedCommands = bufferedCommands;
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
  const commandReceipt = async (tx: Tx, command: TeamCommand) => {
    const digest = await coordinatorOperationKey(JSON.stringify(command));
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
    const saved = Schema.decodeUnknownSync(TeamCommandSchema, {
      onExcessProperty: "error",
    })(task.input);
    if ((await coordinatorOperationKey(JSON.stringify(saved))) !== digest) {
      throw new InvalidInput({ reason: "The saved team command changed." });
    }
    return { digest, document, taskId: document.receipt.taskId };
  };
  const enqueueAllIn = async (
    tx: Tx,
    items: readonly {
      readonly record: CoordinatorWorkRecord;
      readonly command: TeamCommand;
    }[]
  ): Promise<void> => {
    const prepared = await Promise.all(
      items.map(async (item) => ({
        ...item,
        previous: await commandReceipt(tx, item.command),
      }))
    );
    const records = [...new Set(items.map((item) => item.record))];
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
    for (const { record, command, previous } of prepared) {
      if (previous.taskId !== undefined) {
        continue;
      }
      const limit = command.kind === "cancel" ? 8 : 7;
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
      record.pendingCommands[command.id] = receipt;
    }
  };
  const enqueueIn = async (
    tx: Tx,
    record: CoordinatorWorkRecord,
    command: TeamCommand
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
      if (!matchesCommandInput(buffered, input)) {
        throw new InvalidInput({
          reason: "The team command ID names another input.",
        });
      }
      return true;
    }
    const receipt = await tx.doc(CommandReceipts, commandId, null);
    if (receipt.receipt) {
      const task = await tx.task(receipt.receipt.taskId);
      const saved = task
        ? Schema.decodeUnknownSync(TeamCommandSchema, {
            onExcessProperty: "error",
          })(task.input)
        : undefined;
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
    } else if (!workHoldsSlot(record, now()) || !acceptsCommands(record)) {
      throw new InvalidInput({ reason: "This work no longer accepts input." });
    }
    await enqueueIn(tx, record, command);
    return { ...publicWork(record), accepted: true };
  };

  return { commandIn, enqueueIn, enqueueAllIn };
};
