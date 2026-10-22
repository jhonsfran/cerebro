import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
} from "@cerebro/contracts/failures";
import type { ChatControl } from "@cerebro/contracts/session-service";
import { CompactionTask, LiveDoc, defineDoc } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  JsonObject,
  TaskId,
} from "@earendil-works/pi-durable";
import type { LifecycleJobs, LifecycleJobOutcome } from "agents/lifecycle";
import { Schema } from "effect";

import { piContext } from "./pi-harness.ts";
import type { MetadataTransaction } from "./session-agent.ts";

export const CompactPayload = Schema.Struct({
  instructions: Schema.optional(Schema.String),
  operationId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
});
type CompactCommand = Extract<ChatControl, { kind: "compact" }>;
interface CompactReceipt extends JsonObject {
  instructions: string;
  taskId: TaskId;
}
const CompactReceipts = defineDoc({
  fork: "initial",
  history: "latest",
  scope: "conversation",
  version: 1,
  kind: "cerebro.compact-commands",
  initial: (): { commands: Record<string, CompactReceipt> } => ({
    commands: {},
  }),
});

const requireSameInstructions = (
  previous: { readonly instructions?: string },
  command: CompactCommand
): void => {
  if ((previous.instructions ?? "") !== (command.instructions ?? "")) {
    throw new Conflict({
      code: "digest-mismatch",
      reason: "The compaction operation names another request.",
    });
  }
};
const validate = (command: CompactCommand): void => {
  if (
    command.operationId.length > 256 ||
    (command.instructions?.length ?? 0) > 8000
  ) {
    throw new InvalidInput({
      reason: "The compaction request exceeds its size limit.",
    });
  }
};

export const createConversationCompaction = (options: {
  readonly authorize: () => Promise<void>;
  readonly jobs: LifecycleJobs;
  readonly metadata: MetadataTransaction;
  readonly nativeId: ConversationId;
  readonly persist: () => Promise<void>;
  readonly pi: Harness;
  readonly sessionId: string;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}) => {
  const receipt = async (command: CompactCommand) => {
    const receipts = await options.pi.snapshot(
      CompactReceipts,
      options.nativeId,
      piContext()
    );
    return receipts?.commands[command.operationId];
  };
  const admit = (command: CompactCommand): Promise<TaskId> =>
    options.pi.commit(async (tx) => {
      const receipts = await tx.doc(CompactReceipts, options.nativeId);
      const existing = receipts.commands[command.operationId];
      if (existing) {
        requireSameInstructions(existing, command);
        return existing.taskId;
      }
      const instructions = command.instructions ?? "";
      const taskId = await tx.createTask(
        CompactionTask,
        {
          reason: "manual" as const,
          ...(instructions ? { instructions } : {}),
        },
        {
          conversationId: options.nativeId,
          ownership: { kind: "conversation" },
        }
      );
      const live = await tx.doc(LiveDoc, options.nativeId);
      live.compactions ??= [];
      live.compactions.push({
        taskId,
        reason: "manual",
        blocking: false,
        attempt: 1,
      });
      receipts.commands[command.operationId] = { instructions, taskId };
      return taskId;
    }, piContext());
  return {
    request: async (command: CompactCommand): Promise<TaskId> => {
      validate(command);
      const previous = await receipt(command);
      if (previous) {
        requireSameInstructions(previous, command);
        const task = await options.pi.getTask(previous.taskId, piContext());
        if (task?.state.status === "terminal") {
          return previous.taskId;
        }
      }
      const id = `cerebro-compact:${options.sessionId}:${command.operationId}`;
      await options.metadata(async () => {
        const existing = options.jobs.get(id);
        if (existing) {
          requireSameInstructions(
            Schema.decodeUnknownSync(CompactPayload)(existing.payload),
            command
          );
          return;
        }
        await options.jobs.push({
          id,
          fn: "cerebro-compact",
          singleflight: true,
          recoveryLoop: true,
          time: Date.now(),
          payload: {
            sessionId: options.sessionId,
            operationId: command.operationId,
            ...(command.instructions === undefined
              ? {}
              : { instructions: command.instructions }),
          },
        });
      });
      const taskId = await admit(command);
      await options.persist();
      options.pi.resume();
      options.waitUntil(options.pi.waitForTask(taskId, piContext()));
      return taskId;
    },
    run: async (command: CompactCommand): Promise<LifecycleJobOutcome> => {
      try {
        await options.authorize();
        validate(command);
        const taskId = await admit(command);
        options.pi.resume();
        const task = await options.pi.getTask(taskId, piContext());
        if (task?.state.status === "terminal") {
          return;
        }
        options.waitUntil(options.pi.waitForTask(taskId, piContext()));
        return { rescheduleAt: Date.now() + 5000 };
      } catch (error) {
        if (error instanceof Conflict) {
          return;
        }
        if (
          !(
            error instanceof Denied ||
            error instanceof NotFound ||
            error instanceof InvalidInput
          )
        ) {
          throw error;
        }
        const existing = await receipt(command);
        if (existing) {
          await options.pi.abortTask(existing.taskId, piContext());
        }
      }
    },
  };
};
