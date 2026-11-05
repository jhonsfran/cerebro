import type { BotEvent } from "@cerebro/contracts/bot-events";
import type { EventAddress } from "@cerebro/contracts/events";
import {
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
} from "@cerebro/contracts/failures";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type {
  SlackDelivery,
  SlackDeliveryStore,
  SlackReplyDestination,
} from "@cerebro/contracts/slack-events";
import { toSlackText } from "@cerebro/contracts/slack-text";
import type { LegacyTimerReplyOrigin } from "@cerebro/contracts/timer-events";
import { digestToolArguments } from "@cerebro/contracts/tools";
import {
  defineDoc,
  defineDocFamily,
  defineTask,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  EntryId,
  Harness,
  JsonObject,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";

import { eventOf, BotEventReceipts } from "./coordinator-event-state.ts";
import { WorkDocuments, sameWorkSource } from "./coordinator-ledger.ts";
import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import { timerReplyDestination } from "./saved-timer-state.ts";

export type ReplyOrigin =
  | { readonly kind: "event"; readonly event: BotEvent }
  | {
      readonly kind: "saved-timer";
      readonly destination: SlackReplyDestination;
    };

export interface EventReplyServices {
  readonly destination: (
    event: BotEvent | LegacyTimerReplyOrigin
  ) => Promise<SlackReplyDestination>;
  readonly authorize: (destination: SlackReplyDestination) => Promise<void>;
  readonly deliver: (input: {
    readonly destination: SlackReplyDestination;
    readonly key: string;
    readonly text: string;
    readonly store: SlackDeliveryStore;
    readonly beforePost: () => Promise<void>;
  }) => Promise<void>;
}
export interface CoordinatorReply extends JsonObject {
  eventId: string;
  source: { [Key in keyof EventAddress]: EventAddress[Key] };
  answerEntryId: EntryId;
  destination: SlackReplyDestination | null;
  dependencies: {
    sourceIds: ContentDependencies["sourceIds"][number][];
    toolIds: ContentDependencies["toolIds"][number][];
  };
  key: string;
  text: string;
  delivery: SlackDelivery | null;
  taskId: TaskId | null;
  attempts: number;
  until: number;
}
export type ReplyAnswer =
  | { readonly kind: "native"; readonly entryId: EntryId }
  | {
      readonly kind: "local";
      readonly entryId: EntryId;
      readonly text: string;
    };
export const CoordinatorReplies = defineDocFamily({
  kind: "cerebro.coordinator-reply",
  scope: "session",
  family: true,
  version: 1,
  initial: (_seed: null): { record: CoordinatorReply | null } => ({
    record: null,
  }),
});
const ReplyQueue = defineDoc({
  kind: "cerebro.coordinator-reply-queue",
  scope: "session",
  version: 1,
  initial: (): {
    pending: Record<string, { nativeId: ConversationId; taskId: TaskId }>;
  } => ({ pending: {} }),
});
export const conciseSlackText = (text: string): string => {
  const words = [...text.trim().matchAll(/\S+/gu)];
  const last = words.at(99);
  return words.length > 100 && last
    ? text.trim().slice(0, last.index + last[0].length)
    : text.trim();
};

const finishIn = async (tx: Tx, eventId: string): Promise<void> => {
  const queue = await tx.doc(ReplyQueue);
  Reflect.deleteProperty(queue.pending, eventId);
};

const requiredRetryAt = (delivery: SlackDelivery | null | undefined): number =>
  delivery?.state === "retry" ? (delivery.retryAt ?? 0) : 0;

const canSend = (record: CoordinatorReply): boolean =>
  (!record.delivery || record.delivery.state === "retry") &&
  Date.now() < record.until &&
  requiredRetryAt(record.delivery) < record.until;

export const createCoordinatorReplies = (options: {
  readonly pi: Harness;
  readonly persist: () => Promise<void>;
  readonly resolve: (address: EventAddress) => Promise<{
    readonly deliverReply?: (
      record: CoordinatorReply,
      store: SlackDeliveryStore,
      signal?: AbortSignal
    ) => Promise<void>;
  }>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}) => {
  const read = async (eventId: string): Promise<CoordinatorReply> => {
    const saved = await options.pi.snapshot(
      CoordinatorReplies,
      eventId,
      piContext()
    );
    if (!saved?.record) {
      throw new NotFound({ resource: "Coordinator reply" });
    }
    return saved.record;
  };
  const definition = defineTask<
    { eventId: string },
    | { phase: "send"; attempt: number }
    | { phase: "retry"; attempt: number; until: number },
    { delivered: boolean }
  >({
    name: "cerebro.coordinator-reply",
    version: 1,
    initial: () => ({ phase: "send", attempt: 0 }),
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const saved = await tx.doc(
          CoordinatorReplies,
          task.input.eventId,
          null
        );
        if (
          saved.record &&
          (!saved.record.delivery || saved.record.delivery.state === "retry")
        ) {
          saved.record.delivery = {
            state: "blocked",
            text: saved.record.text,
            reason: "cancelled",
          };
        }
        await finishIn(tx, task.input.eventId);
        return {
          status: "terminal",
          outcome: { status: "aborted", reason: "cancelled" },
        };
      }, context),
    phases: {
      retry: async (task, runtime, context) => {
        await runtime.sleep(task.state.checkpoint.until, context);
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              phase: "send",
              attempt: task.state.checkpoint.attempt,
            },
          }),
          context
        );
      },
      send: async (task, runtime, context) => {
        const record = await read(task.input.eventId);
        if (record.taskId !== runtime.taskId || !record.destination) {
          throw new InvalidInput({ reason: "The saved reply task changed." });
        }
        const requiredWait = requiredRetryAt(record.delivery);
        if (requiredWait > Date.now() && requiredWait < record.until) {
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: {
                phase: "retry",
                attempt: task.state.checkpoint.attempt,
                until: requiredWait,
              },
            }),
            context
          );
          return;
        }
        const store: SlackDeliveryStore = {
          get: async (key) => {
            if (key !== record.key) {
              throw new InvalidInput({
                reason: "The reply delivery key changed.",
              });
            }
            const current = await read(record.eventId);
            return current.delivery ?? undefined;
          },
          set: async (key, delivery) => {
            if (key !== record.key || delivery.text !== record.text) {
              throw new InvalidInput({
                reason: "The reply delivery content changed.",
              });
            }
            await options.pi.commit(async (tx) => {
              const saved = await tx.doc(
                CoordinatorReplies,
                record.eventId,
                null
              );
              if (
                !saved.record ||
                saved.record.taskId !== runtime.taskId ||
                saved.record.key !== key
              ) {
                throw new InvalidInput({ reason: "The reply intent changed." });
              }
              saved.record.delivery = delivery;
            }, context);
            await options.persist();
          },
        };
        try {
          if (canSend(record)) {
            const scope = await options.resolve(record.source);
            if (!scope.deliverReply) {
              throw new Denied({
                code: "revoked",
                reason: "Reply delivery is unavailable.",
              });
            }
            await scope.deliverReply(record, store, runtime.signal);
          }
        } catch (error) {
          if (runtime.signal.aborted || context.abortSignal?.aborted) {
            throw error;
          }
          if (error instanceof Denied || error instanceof NotFound) {
            await store.set(record.key, {
              state: "blocked",
              text: record.text,
              reason: "access-changed",
            });
          } else {
            const current = await store.get(record.key);
            if (!current || current.state === "retry") {
              await store.set(
                record.key,
                current ?? {
                  state: "retry",
                  text: record.text,
                }
              );
            }
          }
        }
        const current = await store.get(record.key);
        const attempt = task.state.checkpoint.attempt + 1;
        const retryAt = Math.max(
          Date.now() + 1000 * 2 ** (attempt - 1),
          requiredRetryAt(current)
        );
        if (
          current?.state === "retry" &&
          attempt < 5 &&
          retryAt < record.until
        ) {
          await runtime.commit(async (tx) => {
            const saved = await tx.doc(
              CoordinatorReplies,
              record.eventId,
              null
            );
            if (saved.record) {
              saved.record.attempts = attempt;
            }
            return {
              status: "running",
              checkpoint: {
                phase: "retry",
                attempt,
                until: retryAt,
              },
            };
          }, context);
          return;
        }
        await runtime.commit(async (tx) => {
          const saved = await tx.doc(CoordinatorReplies, record.eventId, null);
          if (saved.record) {
            saved.record.attempts = attempt;
            if (
              !saved.record.delivery ||
              saved.record.delivery.state === "retry"
            ) {
              saved.record.delivery = { state: "failed", text: record.text };
            }
          }
          await finishIn(tx, record.eventId);
          return {
            status: "terminal",
            outcome: {
              status: "completed",
              result: { delivered: current?.state === "sent" },
            },
          };
        }, context);
      },
    },
  });
  const hold = async (nativeId?: ConversationId): Promise<boolean> => {
    const queue = await options.pi.snapshot(ReplyQueue, piContext());
    const tasks = Object.values(queue?.pending ?? {})
      .filter((item) => nativeId === undefined || item.nativeId === nativeId)
      .map((item) => item.taskId);
    if (tasks.length) {
      trackNativeProgress(options.pi, { tasks }, options.waitUntil);
    }
    return tasks.length > 0;
  };
  return {
    definition,
    hold,
    origin: async (event: BotEvent): Promise<ReplyOrigin | null> => {
      if (event.source.kind === "slack") {
        return { kind: "event", event };
      }
      if (event.source.kind === "savedtimer") {
        const destination = await timerReplyDestination(options.pi, event);
        return destination ? { kind: "saved-timer", destination } : null;
      }
      if (
        event.source.kind !== "teamreport" &&
        event.source.kind !== "coordinator-terminalnotice"
      ) {
        return null;
      }
      const work = await options.pi.snapshot(
        WorkDocuments,
        event.source.key.workId,
        piContext()
      );
      if (
        !work?.record?.humanOperationId ||
        !sameWorkSource(
          work.record.admission.sourceEventAddress,
          event.coordinator
        ) ||
        work.record.admission.key.ownerPrincipalId !== event.ownerPrincipalId
      ) {
        return null;
      }
      const original = await options.pi.snapshot(
        BotEventReceipts,
        work.record.humanOperationId,
        piContext()
      );
      if (!original?.receipt) {
        return null;
      }
      const origin = eventOf(original.receipt);
      if (
        !sameWorkSource(origin.coordinator, event.coordinator) ||
        origin.ownerPrincipalId !== event.ownerPrincipalId
      ) {
        return null;
      }
      if (origin.source.kind === "slack") {
        return { kind: "event", event: origin };
      }
      const destination = await timerReplyDestination(options.pi, origin);
      return destination ? { kind: "saved-timer", destination } : null;
    },
    enqueueIn: async (
      tx: Tx,
      input: {
        readonly event: BotEvent;
        readonly nativeId: ConversationId;
        readonly answer: ReplyAnswer;
        readonly destination: SlackReplyDestination | null;
        readonly dependencies: ContentDependencies;
        readonly blocked: boolean;
      }
    ): Promise<void> => {
      const saved = await tx.doc(CoordinatorReplies, input.event.id, null);
      if (saved.record) {
        if (saved.record.answerEntryId !== input.answer.entryId) {
          throw new InvalidInput({ reason: "The reply answer changed." });
        }
        return;
      }
      let answer = input.answer.kind === "local" ? input.answer.text : "";
      if (input.answer.kind === "native") {
        const entry = await tx.entry(input.answer.entryId);
        if (!entry || entry.conversationId !== input.nativeId) {
          throw new InvalidInput({
            reason: "The reply answer belongs to another conversation.",
          });
        }
        answer = (entry.model ?? [])
          .filter((message) => message.role === "assistant")
          .flatMap((message) =>
            message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
          )
          .join("\n");
      }
      const text = conciseSlackText(toSlackText(answer));
      const key = await digestToolArguments([
        input.destination?.authority.thread ?? input.event.id,
        input.event.coordinator.sessionId,
        input.answer.entryId,
      ]);
      const queue = await tx.doc(ReplyQueue);
      const blocked = input.blocked || !text || !input.destination;
      if (!blocked && Object.keys(queue.pending).length >= 96) {
        throw new Unavailable({
          reason: "The reply outbox is full.",
          retryAfter: 5,
        });
      }
      const taskId = blocked
        ? null
        : await tx.createTask(
            definition,
            { eventId: input.event.id },
            {
              background: true,
              conversationId: input.nativeId,
              ownership: { kind: "conversation" },
            }
          );
      saved.record = {
        eventId: input.event.id,
        source: { ...input.event.coordinator },
        answerEntryId: input.answer.entryId,
        destination: input.destination,
        dependencies: {
          sourceIds: [...input.dependencies.sourceIds],
          toolIds: [...input.dependencies.toolIds],
        },
        key,
        text,
        taskId,
        attempts: 0,
        until: Date.now() + 60_000,
        delivery: blocked
          ? { state: "blocked", text, reason: "access-changed" }
          : null,
      };
      if (taskId !== null) {
        queue.pending[input.event.id] = { nativeId: input.nativeId, taskId };
      }
    },
  };
};
export type CoordinatorReplyOutbox = ReturnType<
  typeof createCoordinatorReplies
>;
