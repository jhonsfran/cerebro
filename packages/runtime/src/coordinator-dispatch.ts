import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, InvalidInput, NotFound } from "@cerebro/contracts/failures";
import {
  TeamCommandSchema,
  transitionWorkStatus,
} from "@cerebro/contracts/work";
import type { TeamCommand } from "@cerebro/contracts/work";
import { defineTask } from "@earendil-works/pi-durable";
import type { ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import { Schema } from "effect";

import {
  CommandReceipts,
  WorkDocuments,
  coordinatorOperationKey,
  requireWorkSource,
  sameWorkSource,
  workHoldsSlot,
} from "./coordinator-ledger.ts";
import type { CoordinationBinding } from "./coordinator-ledger.ts";
import type { CoordinationServices } from "./coordinator-work.ts";

type DispatchCheckpoint =
  | { phase: "send"; attempt: number }
  | { phase: "retry"; attempt: number; until: number };
type DispatchResult =
  | { kind: "sent" | "skipped" }
  | { kind: "failed"; reason: string };
const RETRY_ATTEMPTS = 5;

export const createCoordinatorDispatch = (options: {
  readonly address: EventAddress;
  readonly nativeId: ConversationId;
  readonly services?: CoordinationServices;
  readonly pi: Harness;
  readonly authorize: (signal?: AbortSignal) => Promise<void>;
  readonly binding: () => CoordinationBinding;
  readonly now: () => number;
}) => {
  const { now } = options;
  const clearPending = async (tx: Tx, command: TeamCommand) => {
    const document = await tx.doc(WorkDocuments, command.work.key.workId, null);
    if (
      document.record &&
      sameWorkSource(
        document.record.admission.sourceEventAddress,
        options.address
      )
    ) {
      Reflect.deleteProperty(document.record.pendingCommands, command.id);
      return document.record;
    }
  };
  return defineTask<TeamCommand, DispatchCheckpoint, DispatchResult>({
    name: `cerebro.coordinator-dispatch:${options.address.sessionId}`,
    version: 1,
    initial: () => ({ attempt: 0, phase: "send" }),
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        await clearPending(tx, task.input);
        return {
          status: "terminal",
          outcome: { status: "aborted", reason: "cancelled" },
        };
      }, context);
    },
    phases: {
      retry: async (task, runtime, context) => {
        await runtime.sleep(task.state.checkpoint.until, context);
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              attempt: task.state.checkpoint.attempt,
              phase: "send",
            },
          }),
          context
        );
      },
      send: async (task, runtime, context) => {
        const command = Schema.decodeUnknownSync(TeamCommandSchema)(task.input);
        try {
          if (runtime.conversationId !== options.nativeId) {
            throw new Denied({
              code: "unauthorized",
              reason: "The dispatch task belongs to another conversation.",
            });
          }
          await options.authorize(context.abortSignal);
          const source = options.binding();
          const document = await options.pi.snapshot(
            WorkDocuments,
            command.work.key.workId,
            context
          );
          const record = document?.record;
          const receipt = await options.pi.snapshot(
            CommandReceipts,
            command.id,
            context
          );
          if (
            !record ||
            !receipt?.receipt ||
            receipt.receipt.taskId !== runtime.taskId
          ) {
            throw new NotFound({ resource: "Team command" });
          }
          const digest = await coordinatorOperationKey(JSON.stringify(command));
          if (
            receipt.receipt.digest !== digest ||
            JSON.stringify(record.admission) !== JSON.stringify(command.work)
          ) {
            throw new InvalidInput({
              reason: "The saved team command changed.",
            });
          }
          requireWorkSource(record, source);
          if (
            command.kind !== "cancel" &&
            (!workHoldsSlot(record, now()) ||
              (record.status.kind !== "accepted" &&
                record.status.kind !== "running"))
          ) {
            await runtime.commit(async (tx) => {
              await clearPending(tx, command);
              return {
                status: "terminal",
                outcome: { status: "completed", result: { kind: "skipped" } },
              };
            }, context);
            return;
          }
          const { services } = options;
          if (!services) {
            throw new Denied({
              code: "revoked",
              reason: "Team coordination is disabled.",
            });
          }
          await services.sendCommand(command);
          await runtime.commit(async (tx) => {
            await clearPending(tx, command);
            return {
              status: "terminal",
              outcome: { status: "completed", result: { kind: "sent" } },
            };
          }, context);
        } catch (error) {
          if (runtime.signal.aborted || context.abortSignal?.aborted) {
            throw error;
          }
          const attempt = task.state.checkpoint.attempt + 1;
          const until = now() + Math.min(30_000, 1000 * 2 ** (attempt - 1));
          await runtime.commit(async (tx) => {
            const document = await tx.doc(
              WorkDocuments,
              command.work.key.workId,
              null
            );
            const { record } = document;
            const owned =
              runtime.conversationId === options.nativeId &&
              record &&
              sameWorkSource(
                record.admission.sourceEventAddress,
                options.address
              ) &&
              (!options.services ||
                record.admission.key.ownerPrincipalId ===
                  options.services.ownerPrincipalId);
            const permanent =
              error instanceof Denied ||
              error instanceof InvalidInput ||
              error instanceof NotFound;
            if (
              owned &&
              !permanent &&
              attempt < RETRY_ATTEMPTS &&
              until < record.admission.deadlineAt
            ) {
              return {
                status: "running",
                checkpoint: { phase: "retry", attempt, until },
              };
            }
            const reason = "The team command could not be delivered.";
            if (owned) {
              Reflect.deleteProperty(record.pendingCommands, command.id);
              record.status = transitionWorkStatus(record.status, {
                kind: "failed",
                reason,
              });
            }
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: { kind: "failed", reason },
              },
            };
          }, context);
        }
      },
    },
  });
};
