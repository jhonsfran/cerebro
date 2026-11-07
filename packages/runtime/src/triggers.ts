/* oxlint-disable no-await-in-loop -- Backlog placement hands triggers to Pi one at a time in arrival order. */
import type { EventAddress } from "@cerebro/contracts/events";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type {
  ExecutionContext,
  PrincipalId,
} from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { ChatQueuedInput } from "@cerebro/contracts/session-service";
import { TeamEventReturnSchema } from "@cerebro/contracts/team-events";
import type {
  TeamEventCommand,
  TeamEventReturn,
} from "@cerebro/contracts/team-events";
import { digestToolArguments } from "@cerebro/contracts/tools";
import {
  TRIGGER_ENTRY_KIND,
  inputText,
  normalizeTriggerAdmission,
  triggerEntryData,
  triggerId,
} from "@cerebro/contracts/triggers";
import type {
  Trigger,
  TriggerAdmissionInput,
} from "@cerebro/contracts/triggers";
import { BoundedContentDependenciesSchema } from "@cerebro/contracts/work";
import type { SlackThread } from "@cerebro/contracts/work";
import { InboxDoc } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationId,
  Cursor,
  EntryId,
  Harness,
  SubmissionId,
  Tx,
} from "@earendil-works/pi-durable";
import { Effect, Result, Schema } from "effect";

import { ProfileChanged } from "./conversation-bindings.ts";
import type { ConversationProfile } from "./conversation-profile.ts";
import {
  WorkDocuments,
  requireCoordinatorWork,
  requireWorkSource,
  sameWorkSource,
} from "./coordinator-ledger.ts";
import { listSubscribedBotSources } from "./coordinator-subscriptions.ts";
import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import { Backlog, Receipts, copyTriggerReceipt } from "./trigger-receipts.ts";
import type {
  EventSkip,
  TriggerReceipt,
  TriggerRoute,
} from "./trigger-receipts.ts";

export { Backlog, Receipts } from "./trigger-receipts.ts";
export type {
  EventRecipient,
  EventSkip,
  TriggerReceipt,
  TriggerRoute,
} from "./trigger-receipts.ts";

export const MAX_WAITING = 64;

export type TriggerAction = "admit" | "deliver" | "read" | "control";
export type RouteIn = (
  tx: Tx
) => Promise<
  | { kind: "inbox"; skipped?: EventSkip[] }
  | Extract<TriggerRoute, { kind: "teams" | "control" | "local-answer" }>
>;
export interface TriggerScope {
  readonly native: Conversation;
  readonly ownerPrincipalId: PrincipalId;
  readonly requireCurrent: () => void;
  readonly authorize: (
    trigger: Trigger,
    context: ExecutionContext | undefined,
    action: TriggerAction,
    signal?: AbortSignal
  ) => Promise<void>;
  readonly commit: <A>(
    key: string,
    change: (tx: Tx) => Promise<A>
  ) => Promise<A>;
  readonly gate: () => Promise<"open" | "waiting">;
  readonly route?: (
    admission: TriggerAdmissionInput,
    context: ExecutionContext
  ) => Promise<RouteIn>;
  readonly localAnswer?: (
    trigger: Trigger,
    action: "status" | "stop",
    context: ExecutionContext
  ) => Promise<RouteIn>;
  readonly routingAccess?: (
    context: ExecutionContext,
    dependencies: ContentDependencies
  ) => Promise<void>;
  readonly readAccess: (context: ExecutionContext) => Promise<void>;
}
export type TriggerPlacement =
  | { readonly kind: "backlog" }
  | { readonly kind: "queued"; readonly submissionId: SubmissionId }
  | {
      readonly kind: "placed";
      readonly submissionId: SubmissionId;
      readonly entry: EntryId;
    }
  | {
      readonly kind: "done";
      readonly submissionId: SubmissionId;
      readonly entry: EntryId;
      readonly answer: EntryId;
    }
  | {
      readonly kind: "unanswered";
      readonly submissionId: SubmissionId;
      readonly reason: string;
    }
  | { readonly kind: "withdrawn" }
  | { readonly kind: "local-answer"; readonly answer: EntryId }
  | { readonly kind: "routed"; readonly route: "teams" | "control" };

const run = async <A>(
  program: Effect.Effect<A, ContractFailure>
): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};
const permanent = (error: unknown): boolean =>
  error instanceof Denied ||
  error instanceof InvalidInput ||
  error instanceof NotFound;
const handedToPi = (route: TriggerRoute): boolean =>
  route.kind === "inbox" ||
  (route.kind === "teams" &&
    route.recipients.some((item) => item.disposition.kind === "returned"));

export const placementIn = async (
  tx: Tx,
  receipt: TriggerReceipt
): Promise<TriggerPlacement> => {
  const { route } = receipt;
  if (route.kind === "local-answer") {
    return { kind: "local-answer", answer: route.answerEntry };
  }
  if (route.kind === "control") {
    return { kind: "routed", route: "control" };
  }
  if (!handedToPi(route)) {
    return { kind: "routed", route: "teams" };
  }
  const backlog = await tx.doc(Backlog, receipt.nativeId);
  if (backlog.ids.includes(receipt.trigger.id)) {
    return { kind: "backlog" };
  }
  const submission = await tx.submissionByRequest(
    receipt.nativeId,
    receipt.trigger.id
  );
  if (submission?.type !== "input") {
    return { kind: "withdrawn" };
  }
  switch (submission.status) {
    case "queued": {
      return { kind: "queued", submissionId: submission.id };
    }
    case "placed": {
      return {
        kind: "placed",
        submissionId: submission.id,
        entry: submission.entry,
      };
    }
    case "done": {
      return {
        kind: "done",
        submissionId: submission.id,
        entry: submission.entry,
        answer: submission.answer,
      };
    }
    case "unanswered": {
      return {
        kind: "unanswered",
        submissionId: submission.id,
        reason: submission.reason,
      };
    }
    default: {
      const exhaustive: never = submission;
      return exhaustive;
    }
  }
};

const requireScope = (receipt: TriggerReceipt, scope: TriggerScope) => {
  if (
    scope.native.id !== receipt.nativeId ||
    scope.ownerPrincipalId !== receipt.trigger.ownerPrincipalId
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The event belongs to another coordinator.",
    });
  }
};
const placeIn = async (
  tx: Tx,
  id: string,
  nativeId: ConversationId
): Promise<void> => {
  const backlog = await tx.doc(Backlog, nativeId);
  if (backlog.ids.includes(id)) {
    return;
  }
  const inbox = await tx.doc(InboxDoc, nativeId);
  const waiting =
    inbox.items.filter((item) => item.mode !== "write").length +
    backlog.ids.length;
  if (waiting >= MAX_WAITING) {
    throw new Unavailable({
      reason: "The coordinator inbox is full. Retry delivery later.",
      retryAfter: 5,
    });
  }
  backlog.ids.push(id);
};
const removeIn = async (
  tx: Tx,
  nativeId: ConversationId,
  id: string
): Promise<void> => {
  const backlog = await tx.doc(Backlog, nativeId);
  backlog.ids = backlog.ids.filter((value) => value !== id);
};
const returnIn = async (
  tx: Tx,
  delivery: TeamEventReturn,
  origin: "team" | "source" = "team"
): Promise<void> => {
  const document = await tx.doc(Receipts, delivery.eventId, null);
  const { receipt } = document;
  if (
    !receipt ||
    receipt.digest !== delivery.eventDigest ||
    receipt.route.kind !== "teams"
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The returned event has no matching Team route.",
    });
  }
  const { trigger } = receipt;
  const record = await requireCoordinatorWork(
    tx,
    { address: trigger.address, ownerPrincipalId: trigger.ownerPrincipalId },
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
    !sameWorkSource(trigger.address, delivery.work.sourceEventAddress)
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
  const first = !handedToPi(receipt.route);
  recipient.disposition = { kind: "returned", digest };
  if (first) {
    await placeIn(tx, trigger.id, receipt.nativeId);
  }
};
export const createTriggers = (options: {
  readonly pi: Harness;
  readonly targetIn: (
    tx: Tx,
    address: EventAddress
  ) => Promise<{ readonly nativeId: ConversationId }>;
  readonly resolve: (address: EventAddress) => Promise<TriggerScope>;
  readonly scan: (
    cursor?: Cursor
  ) => Promise<{ readonly keys: readonly string[]; readonly next?: Cursor }>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}) => {
  const inflight = new Map<ConversationId, Promise<"idle" | "waiting">>();
  const read = async (id: string): Promise<TriggerReceipt> => {
    const document = await options.pi.snapshot(Receipts, id, piContext());
    if (!document?.receipt) {
      throw new NotFound({ resource: "Coordinator event" });
    }
    return document.receipt;
  };
  const acceptIn = async (
    tx: Tx,
    input: TriggerAdmissionInput,
    routeIn?: RouteIn
  ): Promise<TriggerReceipt> => {
    const { wire, trigger } = normalizeTriggerAdmission(input);
    if (trigger.id !== (await triggerId(trigger.address, trigger.origin))) {
      throw new InvalidInput({
        reason: "The event ID does not match its origin.",
      });
    }
    const digest = await digestToolArguments(wire);
    const document = await tx.doc(Receipts, trigger.id, null);
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
      return copyTriggerReceipt(document.receipt);
    }
    const target = await options.targetIn(tx, trigger.address);
    const routed = routeIn ? await routeIn(tx) : { kind: "inbox" as const };
    const route: TriggerRoute =
      routed.kind === "inbox"
        ? { kind: "inbox", skipped: routed.skipped ?? [] }
        : routed;
    if (route.kind === "inbox") {
      await placeIn(tx, trigger.id, target.nativeId);
    }
    const receipt: TriggerReceipt = {
      trigger,
      digest,
      nativeId: target.nativeId,
      duplicates: 0,
      route,
    };
    document.receipt = receipt;
    return copyTriggerReceipt(receipt);
  };
  const placeOne = async (
    scope: TriggerScope,
    nativeId: ConversationId,
    id: string
  ): Promise<void> => {
    const receipt = await read(id);
    if (receipt.nativeId !== nativeId || !handedToPi(receipt.route)) {
      throw new InvalidInput({
        reason: "The saved coordinator event changed.",
      });
    }
    requireScope(receipt, scope);
    let denied = false;
    try {
      await scope.authorize(receipt.trigger, undefined, "deliver");
    } catch (error) {
      if (!permanent(error)) {
        throw error;
      }
      if ((await scope.gate()) === "waiting") {
        throw new ProfileChanged();
      }
      scope.requireCurrent();
      denied = true;
    }
    if (!denied) {
      const current = await options.pi.snapshot(Backlog, nativeId, piContext());
      if (!current?.ids.includes(id)) {
        return;
      }
      await scope.native.submit(
        {
          type: "input",
          requestId: id,
          whenBusy: "followUp",
          content: inputText(receipt.trigger),
          entry: {
            kind: TRIGGER_ENTRY_KIND,
            data: triggerEntryData(receipt.trigger),
          },
        },
        piContext()
      );
    }
    await options.pi.commit((tx) => removeIn(tx, nativeId, id), piContext());
  };
  const drainPass = async (
    nativeId: ConversationId
  ): Promise<"idle" | "waiting"> => {
    for (;;) {
      const backlog = await options.pi.snapshot(Backlog, nativeId, piContext());
      const [first, ...rest] = backlog?.ids ?? [];
      if (first === undefined) {
        return "idle";
      }
      const { trigger } = await read(first);
      let scope = await options.resolve(trigger.address);
      if (scope.native.id !== nativeId) {
        throw new InvalidInput({
          reason: "The coordinator event binding changed.",
        });
      }
      if ((await scope.gate()) === "waiting") {
        return "waiting";
      }
      scope = await options.resolve(trigger.address);
      try {
        for (const id of [first, ...rest]) {
          await placeOne(scope, nativeId, id);
        }
      } catch (error) {
        if (!(error instanceof ProfileChanged)) {
          throw error;
        }
      }
    }
  };
  const drain = (nativeId: ConversationId): Promise<"idle" | "waiting"> => {
    const previous = inflight.get(nativeId);
    const pass = (async () => {
      await Promise.allSettled([previous]);
      return await drainPass(nativeId);
    })();
    inflight.set(nativeId, pass);
    const settle = async () => {
      await Promise.allSettled([pass]);
      if (inflight.get(nativeId) === pass) {
        inflight.delete(nativeId);
      }
      trackNativeProgress(
        options.pi,
        { conversations: [nativeId] },
        options.waitUntil
      );
    };
    options.waitUntil(settle());
    return pass;
  };
  return {
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
    acceptIn,
    drain,
    drainAll: (nativeIds: readonly ConversationId[]) =>
      Promise.all(nativeIds.map((nativeId) => drain(nativeId))),
    withdraw: (nativeId: ConversationId) =>
      options.pi.commit(async (tx) => {
        const backlog = await tx.doc(Backlog, nativeId);
        backlog.ids = [];
      }, piContext()),
    queuedWeb: async (nativeId: ConversationId): Promise<ChatQueuedInput[]> => {
      const backlog = await options.pi.snapshot(Backlog, nativeId, piContext());
      const documents = await Promise.all(
        (backlog?.ids ?? []).map((id) =>
          options.pi.snapshot(Receipts, id, piContext())
        )
      );
      return documents.flatMap((document) => {
        const trigger = document?.receipt?.trigger;
        return trigger?.origin.kind === "web"
          ? [
              {
                mode: "followUp" as const,
                operationId: trigger.origin.operationId,
                submissionId: `trigger:${trigger.id}`,
                text: trigger.text,
              },
            ]
          : [];
      });
    },
    placement: (receipt: TriggerReceipt): Promise<TriggerPlacement> =>
      options.pi.commit((tx) => placementIn(tx, receipt), piContext()),
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
      const { trigger } = receipt;
      const scope = await options.resolve(trigger.address);
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
        address: trigger.address,
        ownerPrincipalId: trigger.ownerPrincipalId,
      });
      await scope.authorize(
        {
          ...trigger,
          dependencies: Schema.decodeUnknownSync(
            BoundedContentDependenciesSchema
          )({
            sourceIds: [
              ...new Set([
                ...trigger.dependencies.sourceIds,
                ...delivery.work.contentDependencies.sourceIds,
              ]),
            ],
            toolIds: [
              ...new Set([
                ...trigger.dependencies.toolIds,
                ...delivery.work.contentDependencies.toolIds,
              ]),
            ],
          }),
        },
        context,
        "admit"
      );
      await scope.commit(
        `return:${delivery.eventId}:${delivery.work.key.workId}`,
        (tx) => returnIn(tx, delivery)
      );
      options.waitUntil(drain(scope.native.id));
      return {
        eventId: delivery.eventId,
        key: delivery.work.key,
        accepted: true,
      };
    },
    admit: async (
      input: TriggerAdmissionInput,
      context: ExecutionContext
    ): Promise<TriggerReceipt> => {
      const { wire, trigger, routing } = normalizeTriggerAdmission(input);
      const scope = await options.resolve(trigger.address);
      if (scope.ownerPrincipalId !== trigger.ownerPrincipalId) {
        throw new Denied({
          code: "unauthorized",
          reason: "The event owner changed.",
        });
      }
      await scope.authorize(
        trigger,
        context,
        routing.kind === "local-control" ? "control" : "admit"
      );
      const previous = await options.pi.snapshot(
        Receipts,
        trigger.id,
        piContext()
      );
      if (
        previous?.receipt &&
        previous.receipt.digest !== (await digestToolArguments(wire))
      ) {
        throw new Conflict({
          code: "digest-mismatch",
          reason: "The event ID names another payload.",
        });
      }
      let routeIn: RouteIn | undefined;
      if (!previous?.receipt && routing.kind !== "direct") {
        routeIn =
          routing.kind === "local-control"
            ? await scope.localAnswer?.(trigger, routing.action, context)
            : await scope.route?.(wire, context);
        if (!routeIn) {
          throw new Denied({
            code: "revoked",
            reason: "External event routing is unavailable.",
          });
        }
      }
      const receipt = await scope.commit(trigger.id, (tx) => {
        scope.requireCurrent();
        return acceptIn(tx, wire, routeIn);
      });
      if (handedToPi(receipt.route)) {
        options.waitUntil(drain(scope.native.id));
      }
      return receipt;
    },
    read: async (
      id: string,
      context: ExecutionContext
    ): Promise<TriggerReceipt> => {
      const receipt = await read(id);
      const scope = await options.resolve(receipt.trigger.address);
      requireScope(receipt, scope);
      await scope.authorize(receipt.trigger, context, "read");
      scope.requireCurrent();
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
        sameWorkSource(receipt.trigger.address, address)
      );
      await Promise.all(
        items.map(async (receipt) => {
          requireScope(receipt, scope);
          await scope.authorize(receipt.trigger, context, "read");
        })
      );
      scope.requireCurrent();
      return { items, ...(page.next ? { next: page.next } : {}) };
    },
  };
};
export type Triggers = ReturnType<typeof createTriggers>;

export const profileTriggerScope = async (
  profile: ConversationProfile,
  options: {
    readonly native: Conversation;
    readonly isCurrent: () => boolean;
    readonly gate: () => Promise<"open" | "waiting">;
  }
): Promise<TriggerScope> => {
  const { runtime, coordination, subscriptions, web } = profile;
  const { configuration } = runtime;
  const requireCurrent = () => {
    if (!options.isCurrent()) {
      throw new ProfileChanged();
    }
  };
  const coherent = async <A>(operation: () => Promise<A>): Promise<A> => {
    try {
      return await operation();
    } finally {
      requireCurrent();
    }
  };
  const owner = await coherent(() => run(configuration.ownerContext()));
  const guarded =
    (operation: RouteIn): RouteIn =>
    async (tx) => {
      await runtime.guardIn(tx);
      return await operation(tx);
    };
  return {
    native: options.native,
    requireCurrent,
    ownerPrincipalId: owner.represented?.id ?? owner.actor.id,
    commit: (key, change) => coordination.admissions.commit(key, change),
    gate: options.gate,
    route: (input, context) =>
      coherent(async () => {
        if (configuration.coordination) {
          return guarded(await subscriptions.prepare(input, context));
        }
        if (normalizeTriggerAdmission(input).routing.kind !== "automatic") {
          throw new Denied({
            code: "revoked",
            reason: "Team coordination is disabled.",
          });
        }
        return guarded(() => Promise.resolve({ kind: "inbox" as const }));
      }),
    localAnswer: (trigger, action, context) =>
      coherent(async () =>
        guarded(await web.localAnswer(trigger, action, context))
      ),
    routingAccess: (context, dependencies) =>
      coherent(async () => {
        if (!configuration.coordination) {
          throw new Denied({
            code: "revoked",
            reason: "Team coordination is disabled.",
          });
        }
        await runtime.authorize(context, "coordinate");
        await runtime.authorize(context, "transfer");
        await run(
          configuration.checkDependencies(context, dependencies, {
            deadlineAt: Date.now() + 30_000,
          })
        );
      }),
    readAccess: (context) => coherent(() => runtime.authorize(context, "read")),
    authorize: (trigger, context, action, signal) =>
      coherent(async () => {
        const caller = context ?? (await run(configuration.ownerContext()));
        let permission: "read" | "coordinate" | "send" = "send";
        if (action === "read") {
          permission = "read";
        } else if (
          configuration.coordination ||
          action === "control" ||
          action === "admit"
        ) {
          permission = "coordinate";
        }
        await runtime.authorize(caller, permission, signal);
        if (action !== "read") {
          await runtime.authorize(caller, "transfer", signal);
        }
        await run(
          configuration.checkDependencies(caller, trigger.dependencies, {
            deadlineAt: Date.now() + 30_000,
            signal,
          })
        );
      }),
  };
};
