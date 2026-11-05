import { botEventId } from "@cerebro/contracts/bot-events";
import type { BotEvent } from "@cerebro/contracts/bot-events";
import { normalizeEventAdmission } from "@cerebro/contracts/bot-routing";
import type { EventAdmission } from "@cerebro/contracts/bot-routing";
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
import type { ContentDependencies } from "@cerebro/contracts/session";
import { TeamEventReturnSchema } from "@cerebro/contracts/team-events";
import type {
  TeamEventCommand,
  TeamEventReturn,
} from "@cerebro/contracts/team-events";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { BoundedContentDependenciesSchema } from "@cerebro/contracts/work";
import type { SlackThread } from "@cerebro/contracts/work";
import { defineDoc, defineTask } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationId,
  Cursor,
  Harness,
  SettledSubmissionRecord,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import type { createCoordinatorAdmissions } from "./coordinator-admission.ts";
import {
  BotEventReceipts,
  BotEventSequence,
  copyEventReceipt,
  eventOf,
} from "./coordinator-event-state.ts";
import type {
  BotEventAdmission,
  BotEventReceipt,
  CoordinatorEventDelivery,
  EventSkip,
} from "./coordinator-event-state.ts";
import {
  WorkDocuments,
  requireCoordinatorWork,
  requireWorkSource,
  sameWorkSource,
} from "./coordinator-ledger.ts";
import { listSubscribedBotSources } from "./coordinator-subscriptions.ts";
import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import type { PiContext } from "./pi-harness.ts";

export { BotEventReceipts } from "./coordinator-event-state.ts";
export type {
  BotEventAdmission,
  BotEventReceipt,
} from "./coordinator-event-state.ts";
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
  claim: { agentVersion: number; requestId: string },
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
  readonly prepareRoute?: (
    input: EventAdmission,
    context: ExecutionContext
  ) => Promise<EventRouteIn>;
  readonly prepareLocalControl?: (
    event: BotEvent,
    action: "status" | "stop",
    context: ExecutionContext
  ) => Promise<EventRouteIn>;
  readonly routingAccess?: (
    context: ExecutionContext,
    dependencies: ContentDependencies
  ) => Promise<void>;
  readonly authorize: (
    event: BotEvent,
    context?: ExecutionContext,
    signal?: AbortSignal,
    action?: "deliver" | "read"
  ) => Promise<void>;
}
export type EventRouteIn = (
  tx: Tx
) => Promise<
  | { kind: "coordinator"; skipped?: EventSkip[] }
  | Extract<
      BotEventReceipt["route"],
      { kind: "teams" | "control" | "local-answer" }
    >
>;
export type EventTargetIn = (
  tx: Tx,
  address: EventAddress
) => Promise<{
  readonly nativeId: ConversationId;
  readonly agentVersion: number;
}>;
const requireScope = (receipt: BotEventReceipt, scope: BotEventScope): void => {
  if (
    scope.native.id !== receipt.nativeId ||
    scope.ownerPrincipalId !== eventOf(receipt).ownerPrincipalId
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
const deliveryOf = (receipt: BotEventReceipt): CoordinatorEventDelivery => {
  if (receipt.delivery.kind !== "coordinator") {
    throw new InvalidInput({
      reason: "The event has no coordinator delivery.",
    });
  }
  return receipt.delivery;
};
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
    const claim = deliveryOf(receipt).admission;
    if (claim.kind === "settled") {
      return claim;
    }
    if (claim.kind === "claimed" || claim.kind === "submitted") {
      const saved = await options.pi.commit(
        (tx) => tx.submissionByRequest(receipt.nativeId, claim.requestId),
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
        if (
          document.receipt &&
          deliveryOf(document.receipt).admission.kind !== "settled"
        ) {
          deliveryOf(document.receipt).admission = admission;
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
            deliveryOf(receipt).taskId !== runtime.taskId ||
            receipt.nativeId !== runtime.conversationId ||
            receipt.digest !== (await digestToolArguments(receipt.input))
          ) {
            throw new InvalidInput({
              reason: "The saved coordinator event changed.",
            });
          }
          const scope = await options.resolve(eventOf(receipt).coordinator);
          requireScope(receipt, scope);
          await scope.authorize(
            eventOf(receipt),
            undefined,
            context.abortSignal
          );
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
            const target = await options.targetIn(
              tx,
              eventOf(saved).coordinator
            );
            if (
              target.nativeId !== saved.nativeId ||
              target.agentVersion !== scope.agentVersion
            ) {
              throw new InvalidInput({
                reason: "The coordinator event configuration changed.",
              });
            }
            if (deliveryOf(saved).admission.kind === "held") {
              deliveryOf(saved).admission = {
                kind: "claimed",
                agentVersion: target.agentVersion,
                requestId: eventOf(saved).id,
              };
            }
            const claim = deliveryOf(saved).admission;
            if (
              (claim.kind === "claimed" || claim.kind === "submitted") &&
              claim.agentVersion !== target.agentVersion
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
          const claimed = deliveryOf(receipt).admission;
          if (claimed.kind === "settled") {
            await runtime.commit(async (tx) => {
              await finishIn(tx, task.input.eventId);
              return {
                status: "terminal",
                outcome: { status: "completed", result: { kind: "settled" } },
              };
            }, context);
            return;
          }
          if (claimed.kind === "held") {
            throw new InvalidInput({
              reason: "The event has no admission claim.",
            });
          }
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
                content: botEventInput(eventOf(receipt)),
                entry: {
                  kind: "cerebro.bot-event-input",
                  data: {
                    eventId: eventOf(receipt).id,
                    source: eventOf(receipt).source.kind,
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
            if (
              document.receipt?.delivery.kind === "coordinator" &&
              document.receipt.delivery.admission.kind === "claimed"
            ) {
              deliveryOf(document.receipt).admission = {
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
              deliveryOf(document.receipt).admission = admission;
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
        const claim = deliveryOf(receipt).admission;
        if (claim.kind !== "submitted") {
          throw new InvalidInput({
            reason: "The event has no saved submission.",
          });
        }
        const submission = await options.pi.submission(
          claim.submissionId,
          context
        );
        if (!submission) {
          throw new NotFound({ resource: "Event submission" });
        }
        try {
          const scope = await options.resolve(eventOf(receipt).coordinator);
          requireScope(receipt, scope);
          await scope.authorize(
            eventOf(receipt),
            undefined,
            context.abortSignal
          );
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
        await runtime.commit(async (tx) => {
          const document = await tx.doc(
            BotEventReceipts,
            task.input.eventId,
            null
          );
          if (document.receipt) {
            deliveryOf(document.receipt).admission = settledAdmission(
              claim,
              result
            );
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
  const reserveDeliveryIn = async (
    tx: Tx,
    event: BotEvent,
    nativeId: ConversationId
  ): Promise<CoordinatorEventDelivery> => {
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
    const taskId = await tx.createTask(
      definition,
      { eventId: event.id },
      {
        conversationId: nativeId,
        background: true,
        ownership: { kind: "conversation" },
      }
    );
    queue.pending[event.id] = { nativeId, taskId, internal };
    return { kind: "coordinator", taskId, admission: { kind: "held" } };
  };
  const enqueueIn = async (
    tx: Tx,
    input: EventAdmission,
    routeIn?: EventRouteIn
  ): Promise<BotEventReceipt> => {
    const { wire, event } = normalizeEventAdmission(input);
    if (event.id !== (await botEventId(event.coordinator, event.source))) {
      throw new InvalidInput({
        reason: "The event ID does not match its source.",
      });
    }
    const digest = await digestToolArguments(wire);
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
      return copyEventReceipt(document.receipt);
    }
    const target = await options.targetIn(tx, event.coordinator);
    const counter = await tx.doc(BotEventSequence, target.nativeId);
    if (!Number.isSafeInteger(counter.next + 1)) {
      throw new Unavailable({
        reason: "The coordinator event sequence is unavailable.",
      });
    }
    counter.next += 1;
    const fields = {
      input: wire,
      digest,
      nativeId: target.nativeId,
      sequence: counter.next,
      duplicates: 0,
    };
    const route = routeIn
      ? await routeIn(tx)
      : { kind: "coordinator" as const };
    let receipt: BotEventReceipt;
    switch (route.kind) {
      case "coordinator": {
        receipt = {
          ...fields,
          route: { kind: "coordinator", skipped: route.skipped ?? [] },
          delivery: await reserveDeliveryIn(tx, event, target.nativeId),
        };
        break;
      }
      case "teams": {
        receipt = { ...fields, route, delivery: { kind: "none" } };
        break;
      }
      case "control": {
        receipt = { ...fields, route, delivery: { kind: "none" } };
        break;
      }
      case "local-answer": {
        receipt = { ...fields, route, delivery: { kind: "none" } };
        break;
      }
      default: {
        const exhaustive: never = route;
        throw new InvalidInput({ reason: String(exhaustive) });
      }
    }
    document.receipt = receipt;
    return copyEventReceipt(receipt);
  };
  const hold = async (nativeId?: ConversationId): Promise<boolean> => {
    const queue = await options.pi.snapshot(BotEventQueue, piContext());
    const tasks = Object.values(queue?.pending ?? {})
      .filter((item) => nativeId === undefined || item.nativeId === nativeId)
      .map((item) => item.taskId);
    trackNativeProgress(options.pi, { tasks }, options.waitUntil);
    return tasks.length > 0;
  };
  const returnIn = async (
    tx: Tx,
    delivery: TeamEventReturn,
    origin: "team" | "source" = "team"
  ): Promise<void> => {
    const document = await tx.doc(BotEventReceipts, delivery.eventId, null);
    const { receipt } = document;
    if (
      !receipt ||
      receipt.digest !== delivery.eventDigest ||
      receipt.route.kind !== "teams" ||
      receipt.digest !== (await digestToolArguments(receipt.input))
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "The returned event has no matching Team route.",
      });
    }
    const event = eventOf(receipt);
    const record = await requireCoordinatorWork(
      tx,
      { address: event.coordinator, ownerPrincipalId: event.ownerPrincipalId },
      delivery.work.key.workId
    );
    if (origin === "team" && !record.dispatched) {
      throw new Denied({
        code: "unauthorized",
        reason: "Queued work has not received this event.",
      });
    }
    const admissionDigest = await digestToolArguments(delivery.work);
    const recipient = receipt.route.recipients.find(
      (item) => item.key.workId === delivery.work.key.workId
    );
    if (
      !recipient ||
      recipient.admissionDigest !== admissionDigest ||
      (await digestToolArguments(record.admission)) !== admissionDigest ||
      !sameWorkSource(event.coordinator, delivery.work.sourceEventAddress)
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "This work did not receive the original event.",
      });
    }
    const digest = await digestToolArguments(delivery);
    if (recipient.disposition.kind === "not-delivered") {
      throw new Denied({
        code: "unauthorized",
        reason: "This event was never delivered to the queued Team.",
      });
    }
    if (recipient.disposition.kind === "returned") {
      if (origin === "team" && recipient.disposition.digest !== digest) {
        throw new Conflict({
          code: "digest-mismatch",
          reason: "The event return ID names another reason.",
        });
      }
      return;
    }
    recipient.disposition = { kind: "returned", digest };
    if (receipt.delivery.kind === "none") {
      receipt.delivery = await reserveDeliveryIn(tx, event, receipt.nativeId);
    }
  };
  return {
    definition,
    listSubscribedBotSources: (
      thread: SlackThread,
      context: ExecutionContext
    ) =>
      listSubscribedBotSources({
        pi: options.pi,
        thread,
        context,
        authorize: async (binding, dependencies) => {
          const scope = await options.resolve(binding.address);
          if (
            scope.ownerPrincipalId !== binding.ownerPrincipalId ||
            !scope.routingAccess
          ) {
            throw new Denied({
              code: "unauthorized",
              reason: "The subscribed source is unavailable.",
            });
          }
          await scope.routingAccess(context, dependencies);
        },
      }),
    enqueueIn,
    returnEventIn: (tx: Tx, command: TeamEventCommand) =>
      returnIn(
        tx,
        Schema.decodeUnknownSync(TeamEventReturnSchema)({
          version: 2,
          kind: "event-return",
          work: command.command.work,
          eventId: command.event.id,
          eventDigest: command.event.digest,
        }),
        "source"
      ),
    receiveReturn: async (input: unknown, context: ExecutionContext) => {
      const delivery = Schema.decodeUnknownSync(TeamEventReturnSchema, {
        onExcessProperty: "error",
      })(input);
      const receipt = await read(delivery.eventId);
      const event = eventOf(receipt);
      const scope = await options.resolve(event.coordinator);
      requireScope(receipt, scope);
      const document = await options.pi.snapshot(
        WorkDocuments,
        delivery.work.key.workId,
        piContext()
      );
      if (!document?.record) {
        throw new NotFound({ resource: "Returned work" });
      }
      requireWorkSource(document.record, {
        address: event.coordinator,
        ownerPrincipalId: event.ownerPrincipalId,
      });
      await scope.authorize(
        {
          ...event,
          dependencies: Schema.decodeUnknownSync(
            BoundedContentDependenciesSchema
          )({
            sourceIds: [
              ...new Set([
                ...event.dependencies.sourceIds,
                ...delivery.work.contentDependencies.sourceIds,
              ]),
            ],
            toolIds: [
              ...new Set([
                ...event.dependencies.toolIds,
                ...delivery.work.contentDependencies.toolIds,
              ]),
            ],
          }),
        },
        context
      );
      await scope.admissions.commit(
        `return:${delivery.eventId}:${delivery.work.key.workId}`,
        (tx) => returnIn(tx, delivery)
      );
      await hold(scope.native.id);
      return {
        eventId: delivery.eventId,
        key: delivery.work.key,
        accepted: true,
      };
    },
    admit: async (
      input: EventAdmission,
      context: ExecutionContext
    ): Promise<BotEventReceipt> => {
      const { event, routing } = normalizeEventAdmission(input);
      const scope = await options.resolve(event.coordinator);
      if (scope.ownerPrincipalId !== event.ownerPrincipalId) {
        throw new Denied({
          code: "unauthorized",
          reason: "The event owner changed.",
        });
      }
      await scope.authorize(event, context);
      const previous = await options.pi.snapshot(
        BotEventReceipts,
        event.id,
        piContext()
      );
      if (
        previous?.receipt &&
        previous.receipt.digest !==
          (await digestToolArguments(normalizeEventAdmission(input).wire))
      ) {
        throw new Conflict({
          code: "digest-mismatch",
          reason: "The event ID names another payload.",
        });
      }
      let routeIn: EventRouteIn | undefined;
      if (!previous?.receipt && routing.kind !== "direct") {
        routeIn =
          routing.kind === "local-control"
            ? await scope.prepareLocalControl?.(event, routing.action, context)
            : await scope.prepareRoute?.(input, context);
      }
      if (!previous?.receipt && routing.kind !== "direct" && !routeIn) {
        throw new Denied({
          code: "revoked",
          reason: "External event routing is unavailable.",
        });
      }
      const receipt = await scope.admissions.commit(event.id, (tx) =>
        enqueueIn(tx, input, routeIn)
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
      const scope = await options.resolve(eventOf(receipt).coordinator);
      requireScope(receipt, scope);
      await scope.authorize(eventOf(receipt), context, undefined, "read");
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
        sameWorkSource(eventOf(receipt).coordinator, address)
      );
      await Promise.all(
        items.map(async (receipt) => {
          requireScope(receipt, scope);
          await scope.authorize(eventOf(receipt), context, undefined, "read");
        })
      );
      return { items, ...(page.next ? { next: page.next } : {}) };
    },
  };
};
export type CoordinatorEvents = ReturnType<typeof createCoordinatorEvents>;
