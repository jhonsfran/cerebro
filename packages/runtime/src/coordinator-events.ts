import { BotEventSchema, botEventId } from "@cerebro/contracts/bot-events";
import type { BotEvent } from "@cerebro/contracts/bot-events";
import type { EventAddress } from "@cerebro/contracts/events";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
} from "@cerebro/contracts/failures";
import type {
  ExecutionContext,
  PrincipalId,
} from "@cerebro/contracts/identity";
import { digestToolArguments } from "@cerebro/contracts/tools";
import {
  defineDoc,
  defineDocFamily,
  defineTask,
} from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationId,
  Cursor,
  EntryId,
  Harness,
  JsonObject,
  SettledSubmissionRecord,
  SubmissionId,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import type { createCoordinatorAdmissions } from "./coordinator-admission.ts";
import { sameWorkSource } from "./coordinator-ledger.ts";
import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import type { PiContext } from "./pi-harness.ts";

interface Claim extends JsonObject {
  agentVersion: number;
  requestId: string;
}
export type BotEventAdmission =
  | { kind: "held" }
  | ({ kind: "claimed" } & Claim)
  | ({ kind: "submitted"; submissionId: SubmissionId } & Claim)
  | ({
      kind: "settled";
      outcome: "done";
      submissionId: SubmissionId;
      entry: EntryId;
      answer: EntryId;
    } & Claim)
  | ({
      kind: "settled";
      outcome: "unanswered";
      reason: string;
      submissionId: SubmissionId;
      entry: EntryId | null;
    } & Claim)
  | { kind: "settled"; outcome: "blocked"; reason: string };
type EventCheckpoint =
  | { phase: "deliver"; attempt: number }
  | { phase: "settle"; attempt: number }
  | {
      phase: "retry";
      next: "deliver" | "settle";
      attempt: number;
      until: number;
    };
const settledAdmission = (
  claim: Claim,
  result: SettledSubmissionRecord
): BotEventAdmission =>
  result.type === "input" && result.status === "done"
    ? {
        ...claim,
        kind: "settled",
        outcome: "done",
        submissionId: result.id,
        entry: result.entry,
        answer: result.answer,
      }
    : {
        ...claim,
        kind: "settled",
        outcome: "unanswered",
        submissionId: result.id,
        entry: result.type === "input" ? (result.entry ?? null) : null,
        reason: "The coordinator did not answer this event.",
      };
export interface BotEventReceipt extends JsonObject {
  event: BotEvent;
  digest: string;
  route: { kind: "coordinator"; nativeId: ConversationId };
  taskId: TaskId;
  admission: BotEventAdmission;
  duplicates: number;
}
export const BotEventReceipts = defineDocFamily({
  kind: "cerebro.bot-event",
  scope: "session",
  family: true,
  version: 1,
  initial: (_seed: null): { receipt: BotEventReceipt | null } => ({
    receipt: null,
  }),
});
export const BotEventQueue = defineDoc({
  kind: "cerebro.bot-event-queue",
  scope: "session",
  version: 1,
  initial: (): {
    pending: Record<
      string,
      { nativeId: ConversationId; taskId: TaskId; internal: boolean }
    >;
  } => ({ pending: {} }),
});
const finishIn = async (tx: Tx, id: string): Promise<void> => {
  const queue = await tx.doc(BotEventQueue);
  Reflect.deleteProperty(queue.pending, id);
};
export interface BotEventScope {
  readonly native: Conversation;
  readonly agentVersion: number;
  readonly ownerPrincipalId: PrincipalId;
  readonly admissions: ReturnType<typeof createCoordinatorAdmissions>;
  readonly readAccess: (context: ExecutionContext) => Promise<void>;
  readonly authorize: (
    event: BotEvent,
    context?: ExecutionContext,
    signal?: AbortSignal,
    action?: "deliver" | "read"
  ) => Promise<void>;
}
export type EventTargetIn = (
  tx: Tx,
  address: EventAddress
) => Promise<{
  readonly nativeId: ConversationId;
  readonly agentVersion: number;
}>;
const requireScope = (receipt: BotEventReceipt, scope: BotEventScope): void => {
  if (
    scope.native.id !== receipt.route.nativeId ||
    scope.ownerPrincipalId !== receipt.event.ownerPrincipalId
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The event belongs to another coordinator.",
    });
  }
};
const permanent = (error: unknown): boolean =>
  error instanceof Denied ||
  error instanceof InvalidInput ||
  error instanceof NotFound;
export const botEventInput = (event: BotEvent): string =>
  `Internal coordinator event. This event is not a new human request and cannot approve new team work.\n${JSON.stringify({ source: event.source, content: event.content })}`;

export const createCoordinatorEvents = (options: {
  readonly pi: Harness;
  readonly targetIn: EventTargetIn;
  readonly resolve: (address: EventAddress) => Promise<BotEventScope>;
  readonly scan: (
    cursor?: Cursor
  ) => Promise<{ readonly keys: readonly string[]; readonly next?: Cursor }>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}) => {
  const read = async (id: string) => {
    const document = await options.pi.snapshot(
      BotEventReceipts,
      id,
      piContext()
    );
    if (!document?.receipt) {
      throw new NotFound({ resource: "Coordinator event" });
    }
    return document.receipt;
  };
  const withdraw = async (
    id: string,
    context: PiContext
  ): Promise<BotEventAdmission> => {
    const receipt = await read(id);
    const claim = receipt.admission;
    if (claim.kind === "settled") {
      return claim;
    }
    if (claim.kind === "claimed" || claim.kind === "submitted") {
      const saved = await options.pi.commit(
        (tx) => tx.submissionByRequest(receipt.route.nativeId, claim.requestId),
        context
      );
      const submission =
        saved && (await options.pi.submission(saved.id, context));
      if (submission) {
        await submission.abort(context);
        return settledAdmission(claim, await submission.wait(context));
      }
    }
    return {
      kind: "settled",
      outcome: "blocked",
      reason: "The coordinator event could not be delivered.",
    };
  };
  const definition = defineTask<
    { eventId: string },
    EventCheckpoint,
    { kind: "settled" }
  >({
    name: "cerebro.bot-event-delivery",
    version: 1,
    initial: () => ({ phase: "deliver", attempt: 0 }),
    abort: async (task, runtime, context) => {
      const admission = await withdraw(task.input.eventId, context);
      await runtime.commit(async (tx) => {
        const document = await tx.doc(
          BotEventReceipts,
          task.input.eventId,
          null
        );
        if (document.receipt && document.receipt.admission.kind !== "settled") {
          document.receipt.admission = admission;
        }
        await finishIn(tx, task.input.eventId);
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
              phase: task.state.checkpoint.next,
              attempt: task.state.checkpoint.attempt,
            },
          }),
          context
        );
      },
      deliver: async (task, runtime, context) => {
        try {
          let receipt = await read(task.input.eventId);
          if (
            receipt.taskId !== runtime.taskId ||
            receipt.route.nativeId !== runtime.conversationId ||
            receipt.digest !== (await digestToolArguments(receipt.event))
          ) {
            throw new InvalidInput({
              reason: "The saved coordinator event changed.",
            });
          }
          const scope = await options.resolve(receipt.event.coordinator);
          requireScope(receipt, scope);
          await scope.authorize(receipt.event, undefined, context.abortSignal);
          await runtime.commit(async (tx) => {
            const document = await tx.doc(
              BotEventReceipts,
              task.input.eventId,
              null
            );
            const saved = document.receipt;
            if (!saved) {
              throw new NotFound({ resource: "Coordinator event" });
            }
            const target = await options.targetIn(tx, saved.event.coordinator);
            if (
              target.nativeId !== saved.route.nativeId ||
              target.agentVersion !== scope.agentVersion
            ) {
              throw new InvalidInput({
                reason: "The coordinator event configuration changed.",
              });
            }
            if (saved.admission.kind === "held") {
              saved.admission = {
                kind: "claimed",
                agentVersion: target.agentVersion,
                requestId: saved.event.id,
              };
            }
            if (
              (saved.admission.kind === "claimed" ||
                saved.admission.kind === "submitted") &&
              saved.admission.agentVersion !== target.agentVersion
            ) {
              throw new InvalidInput({
                reason: "The event claim configuration changed.",
              });
            }
            return {
              status: "running",
              checkpoint: {
                phase: "deliver",
                attempt: task.state.checkpoint.attempt,
              },
            };
          }, context);
          receipt = await read(task.input.eventId);
          if (receipt.admission.kind === "settled") {
            await runtime.commit(async (tx) => {
              await finishIn(tx, task.input.eventId);
              return {
                status: "terminal",
                outcome: { status: "completed", result: { kind: "settled" } },
              };
            }, context);
            return;
          }
          if (receipt.admission.kind === "held") {
            throw new InvalidInput({
              reason: "The event has no admission claim.",
            });
          }
          const claimed = receipt.admission;
          const savedSubmission = await options.pi.commit(
            (tx) => tx.submissionByRequest(scope.native.id, claimed.requestId),
            context
          );
          const submission =
            savedSubmission ??
            (await scope.native.submit(
              {
                type: "input",
                requestId: claimed.requestId,
                whenBusy: "followUp",
                content: botEventInput(receipt.event),
                entry: {
                  kind: "cerebro.bot-event-input",
                  data: {
                    eventId: receipt.event.id,
                    source: receipt.event.source.kind,
                    agentVersion: claimed.agentVersion,
                  },
                },
              },
              context
            ));
          await runtime.commit(async (tx) => {
            const document = await tx.doc(
              BotEventReceipts,
              task.input.eventId,
              null
            );
            if (document.receipt?.admission.kind === "claimed") {
              document.receipt.admission = {
                ...claimed,
                kind: "submitted",
                submissionId: submission.id,
              };
            }
            return {
              status: "running",
              checkpoint: { phase: "settle", attempt: 0 },
            };
          }, context);
        } catch (error) {
          if (runtime.signal.aborted || context.abortSignal?.aborted) {
            throw error;
          }
          const attempt = task.state.checkpoint.attempt + 1;
          if (!permanent(error) && attempt < 5) {
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: {
                  phase: "retry",
                  next: "deliver",
                  attempt,
                  until:
                    Date.now() + Math.min(30_000, 1000 * 2 ** (attempt - 1)),
                },
              }),
              context
            );
            return;
          }
          const admission = await withdraw(task.input.eventId, context);
          await runtime.commit(async (tx) => {
            const document = await tx.doc(
              BotEventReceipts,
              task.input.eventId,
              null
            );
            if (document.receipt) {
              document.receipt.admission = admission;
            }
            await finishIn(tx, task.input.eventId);
            return {
              status: "terminal",
              outcome: { status: "completed", result: { kind: "settled" } },
            };
          }, context);
        }
      },
      settle: async (task, runtime, context) => {
        const receipt = await read(task.input.eventId);
        if (receipt.admission.kind !== "submitted") {
          throw new InvalidInput({
            reason: "The event has no saved submission.",
          });
        }
        const submission = await options.pi.submission(
          receipt.admission.submissionId,
          context
        );
        if (!submission) {
          throw new NotFound({ resource: "Event submission" });
        }
        try {
          const scope = await options.resolve(receipt.event.coordinator);
          requireScope(receipt, scope);
          await scope.authorize(receipt.event, undefined, context.abortSignal);
        } catch (error) {
          if (runtime.signal.aborted || context.abortSignal?.aborted) {
            throw error;
          }
          const attempt = task.state.checkpoint.attempt + 1;
          if (!permanent(error) && attempt < 5) {
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: {
                  phase: "retry",
                  next: "settle",
                  attempt,
                  until:
                    Date.now() + Math.min(30_000, 1000 * 2 ** (attempt - 1)),
                },
              }),
              context
            );
            return;
          }
          await submission.abort(context);
        }
        const result = await submission.wait(context);
        const claim = receipt.admission;
        await runtime.commit(async (tx) => {
          const document = await tx.doc(
            BotEventReceipts,
            task.input.eventId,
            null
          );
          if (document.receipt) {
            document.receipt.admission = settledAdmission(claim, result);
          }
          await finishIn(tx, task.input.eventId);
          return {
            status: "terminal",
            outcome: { status: "completed", result: { kind: "settled" } },
          };
        }, context);
      },
    },
  });
  const enqueueIn = async (
    tx: Tx,
    input: BotEvent
  ): Promise<BotEventReceipt> => {
    const event = Schema.decodeUnknownSync(BotEventSchema, {
      onExcessProperty: "error",
    })(input);
    if (event.id !== (await botEventId(event.coordinator, event.source))) {
      throw new InvalidInput({
        reason: "The event ID does not match its source.",
      });
    }
    const digest = await digestToolArguments(event);
    const document = await tx.doc(BotEventReceipts, event.id, null);
    if (document.receipt) {
      if (document.receipt.digest !== digest) {
        throw new Conflict({
          code: "digest-mismatch",
          reason: "The event ID names another payload.",
        });
      }
      document.receipt.duplicates = Math.min(
        1000,
        document.receipt.duplicates + 1
      );
      return {
        ...document.receipt,
        event,
        route: { ...document.receipt.route },
        admission: { ...document.receipt.admission },
      };
    }
    const queue = await tx.doc(BotEventQueue);
    const internal =
      event.source.kind !== "web" && event.source.kind !== "slack";
    const pending = Object.values(queue.pending);
    if (
      pending.length >= 96 ||
      (!internal && pending.filter((item) => !item.internal).length >= 64)
    ) {
      throw new Unavailable({
        reason: "The coordinator event inbox is full. Retry delivery later.",
        retryAfter: 5,
      });
    }
    const target = await options.targetIn(tx, event.coordinator);
    const taskId = await tx.createTask(
      definition,
      { eventId: event.id },
      {
        conversationId: target.nativeId,
        background: true,
        ownership: { kind: "conversation" },
      }
    );
    const receipt: BotEventReceipt = {
      event,
      digest,
      route: { kind: "coordinator", nativeId: target.nativeId },
      taskId,
      admission: { kind: "held" },
      duplicates: 0,
    };
    document.receipt = receipt;
    queue.pending[event.id] = { nativeId: target.nativeId, taskId, internal };
    return receipt;
  };
  const hold = async (nativeId?: ConversationId): Promise<boolean> => {
    const queue = await options.pi.snapshot(BotEventQueue, piContext());
    const tasks = Object.values(queue?.pending ?? {})
      .filter((item) => nativeId === undefined || item.nativeId === nativeId)
      .map((item) => item.taskId);
    trackNativeProgress(options.pi, { tasks }, options.waitUntil);
    return tasks.length > 0;
  };
  return {
    definition,
    enqueueIn,
    admit: async (
      event: BotEvent,
      context: ExecutionContext
    ): Promise<BotEventReceipt> => {
      const scope = await options.resolve(event.coordinator);
      if (scope.ownerPrincipalId !== event.ownerPrincipalId) {
        throw new Denied({
          code: "unauthorized",
          reason: "The event owner changed.",
        });
      }
      await scope.authorize(event, context);
      const receipt = await scope.admissions.commit(event.id, (tx) =>
        enqueueIn(tx, event)
      );
      await hold(scope.native.id);
      return receipt;
    },
    restore: hold,
    wake: hold,
    read: async (
      id: string,
      context: ExecutionContext
    ): Promise<BotEventReceipt> => {
      const receipt = await read(id);
      const scope = await options.resolve(receipt.event.coordinator);
      requireScope(receipt, scope);
      await scope.authorize(receipt.event, context, undefined, "read");
      return receipt;
    },
    list: async (
      address: EventAddress,
      context: ExecutionContext,
      cursor?: Cursor
    ) => {
      const scope = await options.resolve(address);
      await scope.readAccess(context);
      const page = await options.scan(cursor);
      const rows = await Promise.all(page.keys.map((key) => read(key)));
      const items = rows.filter((receipt) =>
        sameWorkSource(receipt.event.coordinator, address)
      );
      await Promise.all(
        items.map(async (receipt) => {
          requireScope(receipt, scope);
          await scope.authorize(receipt.event, context, undefined, "read");
        })
      );
      return { items, ...(page.next ? { next: page.next } : {}) };
    },
  };
};
export type CoordinatorEvents = ReturnType<typeof createCoordinatorEvents>;
