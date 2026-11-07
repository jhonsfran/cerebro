import type { EventAddress } from "@cerebro/contracts/events";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type {
  SlackDelivery,
  SlackDeliveryStore,
} from "@cerebro/contracts/slack-events";
import { toSlackText } from "@cerebro/contracts/slack-text";
import { digestToolArguments } from "@cerebro/contracts/tools";
import {
  REPLY_NUDGE_ENTRY_KIND,
  replyNudgeRequestId,
} from "@cerebro/contracts/triggers";
import type {
  ReplyDestination,
  ReplyPorts,
  Trigger,
} from "@cerebro/contracts/triggers";
import { Type } from "@earendil-works/pi-ai";
import {
  GenerationTask,
  LiveDoc,
  defineDoc,
  defineDocFamily,
  defineTask,
  defineTool,
  hook,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  HookRegistration,
  JsonObject,
  TaskId,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable";
import { Effect, Result } from "effect";

import type { createConversationResources } from "./conversation-resources.ts";
import { coordinationToolResult } from "./coordination-tool-result.ts";
import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import type { SessionHostConfiguration } from "./session-agent.ts";
import { Receipts } from "./trigger-receipts.ts";
import type { TriggerReceipt } from "./trigger-receipts.ts";

export interface Reply extends JsonObject {
  triggerId: string;
  nativeId: ConversationId;
  destination: ReplyDestination;
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
export interface ReplyScope {
  readonly ports: ReplyPorts;
  readonly authorize: (
    destination: ReplyDestination,
    dependencies: ContentDependencies,
    signal?: AbortSignal
  ) => Promise<void>;
}
export const Replies = defineDocFamily({
  kind: "cerebro.coordinator-reply",
  scope: "session",
  family: true,
  version: 2,
  migrate: (): { record: Reply | null } => {
    throw new Error("Unsupported coordinator reply version.");
  },
  initial: (_seed: null): { record: Reply | null } => ({ record: null }),
});
const ReplyQueue = defineDoc({
  kind: "cerebro.coordinator-reply-queue",
  scope: "session",
  version: 1,
  initial: (): {
    pending: Record<string, { nativeId: ConversationId; taskId: TaskId }>;
  } => ({ pending: {} }),
});
const run = async <A>(
  program: Effect.Effect<A, ContractFailure>
): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};
export const conciseSlackText = (text: string): string => {
  const words = [...text.trim().matchAll(/\S+/gu)];
  const last = words.at(99);
  return words.length > 100 && last
    ? text.trim().slice(0, last.index + last[0].length)
    : text.trim();
};
const finishIn = async (tx: Tx, triggerId: string): Promise<void> => {
  const queue = await tx.doc(ReplyQueue);
  Reflect.deleteProperty(queue.pending, triggerId);
};
const requiredRetryAt = (delivery: SlackDelivery | null | undefined): number =>
  delivery?.state === "retry" ? (delivery.retryAt ?? 0) : 0;
const canSend = (record: Reply): boolean =>
  (!record.delivery || record.delivery.state === "retry") &&
  Date.now() < record.until &&
  requiredRetryAt(record.delivery) < record.until;

export const createReplies = (options: {
  readonly pi: Harness;
  readonly persist: () => Promise<void>;
  readonly resolve: (address: EventAddress) => Promise<ReplyScope>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}) => {
  const read = async (triggerId: string): Promise<Reply> => {
    const saved = await options.pi.snapshot(Replies, triggerId, piContext());
    if (!saved?.record) {
      throw new NotFound({ resource: "Coordinator reply" });
    }
    return saved.record;
  };
  const definition = defineTask<
    { triggerId: string },
    | { phase: "send"; attempt: number }
    | { phase: "retry"; attempt: number; until: number },
    { delivered: boolean }
  >({
    name: "cerebro.coordinator-reply",
    version: 1,
    initial: () => ({ phase: "send", attempt: 0 }),
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const saved = await tx.doc(Replies, task.input.triggerId, null);
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
        await finishIn(tx, task.input.triggerId);
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
        const record = await read(task.input.triggerId);
        if (record.taskId !== runtime.taskId) {
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
            const current = await read(record.triggerId);
            return current.delivery ?? undefined;
          },
          set: async (key, delivery) => {
            if (key !== record.key || delivery.text !== record.text) {
              throw new InvalidInput({
                reason: "The reply delivery content changed.",
              });
            }
            await options.pi.commit(async (tx) => {
              const saved = await tx.doc(Replies, record.triggerId, null);
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
            const scope = await options.resolve(record.destination.source);
            const port = scope.ports[record.destination.kind];
            if (!port) {
              throw new Denied({
                code: "revoked",
                reason: "Reply delivery is unavailable.",
              });
            }
            await port.deliver({
              destination: record.destination,
              key: record.key,
              text: record.text,
              store,
              beforePost: async () => {
                runtime.signal.throwIfAborted();
                await scope.authorize(
                  record.destination,
                  record.dependencies,
                  runtime.signal
                );
                runtime.signal.throwIfAborted();
              },
            });
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
                current ?? { state: "retry", text: record.text }
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
            const saved = await tx.doc(Replies, record.triggerId, null);
            if (saved.record) {
              saved.record.attempts = attempt;
            }
            return {
              status: "running",
              checkpoint: { phase: "retry", attempt, until: retryAt },
            };
          }, context);
          return;
        }
        await runtime.commit(async (tx) => {
          const saved = await tx.doc(Replies, record.triggerId, null);
          if (saved.record) {
            saved.record.attempts = attempt;
            if (
              !saved.record.delivery ||
              saved.record.delivery.state === "retry"
            ) {
              saved.record.delivery = { state: "failed", text: record.text };
            }
          }
          await finishIn(tx, record.triggerId);
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
    read: async (triggerId: string): Promise<Reply | undefined> => {
      const saved = await options.pi.snapshot(Replies, triggerId, piContext());
      return saved?.record ?? undefined;
    },
    enqueueIn: async (
      tx: Tx,
      input: {
        readonly trigger: Trigger;
        readonly nativeId: ConversationId;
        readonly text: string;
        readonly dependencies: ContentDependencies;
        readonly blocked: boolean;
      }
    ): Promise<{ readonly blocked: boolean }> => {
      const { trigger } = input;
      const destination = trigger.reply;
      if (!destination) {
        throw new InvalidInput({
          reason: "This event has no external destination.",
        });
      }
      const text = conciseSlackText(toSlackText(input.text));
      const saved = await tx.doc(Replies, trigger.id, null);
      if (saved.record) {
        if (saved.record.text !== text) {
          throw new Conflict({
            code: "digest-mismatch",
            reason: "This event already has another reply.",
          });
        }
        return { blocked: saved.record.delivery?.state === "blocked" };
      }
      const key = await digestToolArguments([
        destination.authority.thread,
        trigger.address.sessionId,
        trigger.id,
      ]);
      const queue = await tx.doc(ReplyQueue);
      const blocked = input.blocked || !text;
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
            { triggerId: trigger.id },
            {
              background: true,
              conversationId: input.nativeId,
              ownership: { kind: "conversation" },
            }
          );
      const record: Reply = {
        triggerId: trigger.id,
        nativeId: input.nativeId,
        destination,
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
      saved.record = record;
      if (taskId !== null) {
        queue.pending[trigger.id] = { nativeId: input.nativeId, taskId };
      }
      return { blocked };
    },
  };
};
export type ReplyOutbox = ReturnType<typeof createReplies>;

export const profileReplyScope = (profile: {
  readonly runtime: Pick<
    ReturnType<typeof createConversationResources>,
    "authorize"
  > & {
    readonly configuration: Pick<
      SessionHostConfiguration,
      "ownerContext" | "checkDependencies" | "replyPorts"
    >;
  };
  readonly requireCurrent: () => void;
}): ReplyScope => {
  const { runtime, requireCurrent } = profile;
  const { configuration } = runtime;
  const ports = configuration.replyPorts ?? {};
  return {
    ports,
    authorize: async (destination, dependencies, signal) => {
      try {
        const caller = await run(configuration.ownerContext());
        await runtime.authorize(caller, "read", signal);
        await run(
          configuration.checkDependencies(caller, dependencies, {
            deadlineAt: Date.now() + 30_000,
            signal,
          })
        );
        const port = ports[destination.kind];
        if (!port) {
          throw new Denied({
            code: "revoked",
            reason: "Reply delivery is unavailable.",
          });
        }
        await port.authorize(destination);
      } finally {
        requireCurrent();
      }
    },
  };
};

export const prepareReply = async (input: {
  readonly trigger: Trigger;
  readonly scope: ReplyScope;
  readonly recorded: ContentDependencies;
}): Promise<{ dependencies: ContentDependencies; blocked: boolean }> => {
  const { trigger } = input;
  const dependencies: ContentDependencies = {
    sourceIds: [
      ...new Set([
        ...input.recorded.sourceIds,
        ...trigger.dependencies.sourceIds,
      ]),
    ],
    toolIds: [
      ...new Set([...input.recorded.toolIds, ...trigger.dependencies.toolIds]),
    ],
  };
  if (!trigger.reply) {
    return { dependencies, blocked: true };
  }
  try {
    await input.scope.authorize(trigger.reply, dependencies);
  } catch (error) {
    if (!(error instanceof Denied || error instanceof NotFound)) {
      throw error;
    }
    return { dependencies, blocked: true };
  }
  return { dependencies, blocked: false };
};

export const createReplyTool = (options: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly replies: Pick<ReplyOutbox, "enqueueIn" | "hold">;
  readonly scope: ReplyScope;
  readonly contentDependencies: () => Promise<ContentDependencies>;
  readonly guardIn: (tx: Tx) => Promise<void>;
}): ToolRegistration =>
  defineTool({
    name: "reply_event",
    callers: ["model"],
    replay: "safe",
    description:
      "Post a reply to the external channel that raised an event, such as a Slack thread. Pass the eventId named in the event message. Each event takes one reply. Web messages have no external destination; the conversation answer is their reply.",
    parameters: Type.Object({
      eventId: Type.String({ minLength: 1, maxLength: 512 }),
      text: Type.String({ minLength: 1, maxLength: 16_000 }),
    }),
    execute: ({ eventId, text }, api, context) =>
      coordinationToolResult(async () => {
        const saved = await options.pi.snapshot(Receipts, eventId, context);
        const receipt: TriggerReceipt | undefined = saved?.receipt ?? undefined;
        if (!receipt) {
          throw new NotFound({ resource: "Coordinator event" });
        }
        if (
          api.conversationId !== options.nativeId ||
          receipt.nativeId !== api.conversationId
        ) {
          throw new Denied({
            code: "unauthorized",
            reason: "The event belongs to another conversation.",
          });
        }
        if (!receipt.trigger.reply) {
          throw new InvalidInput({
            reason:
              "This event has no external destination; the transcript is the reply.",
          });
        }
        const { dependencies, blocked } = await prepareReply({
          trigger: receipt.trigger,
          scope: options.scope,
          recorded: await options.contentDependencies(),
        });
        const recorded = await api.commit(async (tx) => {
          await options.guardIn(tx);
          return await options.replies.enqueueIn(tx, {
            trigger: receipt.trigger,
            nativeId: options.nativeId,
            text,
            dependencies,
            blocked,
          });
        }, context);
        await options.replies.hold(options.nativeId);
        if (recorded.blocked) {
          throw new Denied({
            code: "revoked",
            reason:
              "The reply was recorded but current access blocks posting it.",
          });
        }
        return { eventId, state: "queued" };
      }),
  });

export const createReplyNudge = (options: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
}): HookRegistration =>
  hook(GenerationTask, {
    onYield: async (_answer, api, context) => {
      if (api.conversationId !== options.nativeId) {
        return;
      }
      const live = await api.snapshot(LiveDoc, options.nativeId, context);
      const native = await options.pi.conversation(options.nativeId, context);
      if (!native) {
        return;
      }
      const inputs = await Promise.all(
        (live?.run?.inputs ?? []).map(async (submissionId) => {
          const submission = await options.pi.submission(submissionId, context);
          const record = await submission?.status(context);
          return record?.type === "input" ? record.requestId : undefined;
        })
      );
      for (const id of inputs) {
        if (id === undefined) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- Each unreplied input of the run gets its own durable nudge.
        const unreplied = await options.pi.commit(async (tx) => {
          const receipt = await tx.doc(Receipts, id, null);
          if (!receipt.receipt?.trigger.reply) {
            return false;
          }
          const reply = await tx.doc(Replies, id, null);
          if (reply.record) {
            return false;
          }
          const nudged = await tx.submissionByRequest(
            options.nativeId,
            replyNudgeRequestId(id)
          );
          return nudged === undefined;
        }, context);
        if (!unreplied) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- The follow-up must be durable before the run's final boundary.
        await native.submit(
          {
            type: "input",
            requestId: replyNudgeRequestId(id),
            whenBusy: "followUp",
            content: `Trigger ${id} has no reply yet. Use reply_event, or say in one line why no reply is needed.`,
            entry: { kind: REPLY_NUDGE_ENTRY_KIND, data: { id } },
          },
          piContext()
        );
      }
    },
  });
