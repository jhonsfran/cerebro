import type { BotEvent } from "@cerebro/contracts/bot-events";
import { normalizeEventAdmission } from "@cerebro/contracts/bot-routing";
import type { EventAdmission } from "@cerebro/contracts/bot-routing";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
} from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import { TeamEventCommandSchema } from "@cerebro/contracts/team-events";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { BoundedContentDependenciesSchema } from "@cerebro/contracts/work";
import type { SlackThread } from "@cerebro/contracts/work";
import { Type } from "@earendil-works/pi-ai";
import { defineDocFamily, defineTool } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  JsonObject,
  ToolExecutionApi,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { coordinationToolResult } from "./coordination-tool-result.ts";
import { eventOf } from "./coordinator-event-state.ts";
import type { BotEventReceipt, EventSkip } from "./coordinator-event-state.ts";
import type { EventRouteIn } from "./coordinator-events.ts";
import {
  WorkDocuments,
  WorkLedger,
  coordinatorOperationKey,
  requireCoordinatorWork,
  requireWorkSource,
  sameWorkSource,
  workAcceptsEvents,
} from "./coordinator-ledger.ts";
import type { CoordinationBinding } from "./coordinator-ledger.ts";
import type { createCoordinatorWork } from "./coordinator-work.ts";
import { piContext } from "./pi-harness.ts";

interface StoredBinding extends JsonObject {
  address: BotEvent["coordinator"];
  ownerPrincipalId: CoordinationBinding["ownerPrincipalId"];
}
interface ThreadRecord extends JsonObject {
  binding: StoredBinding;
  thread: SlackThread;
  admittedEventId: string;
  revision: number;
  workIds: string[];
}
export const ThreadSubscriptions = defineDocFamily({
  kind: "cerebro.thread-subscriptions",
  scope: "session",
  family: true,
  version: 1,
  initial: (_seed: null): { record: ThreadRecord | null } => ({ record: null }),
});
export const WorkSubscriptions = defineDocFamily({
  kind: "cerebro.work-subscriptions",
  scope: "session",
  family: true,
  version: 1,
  initial: (
    _seed: null
  ): { record: { binding: StoredBinding; threadKeys: string[] } | null } => ({
    record: null,
  }),
});
export const SubscriptionMutations = defineDocFamily({
  kind: "cerebro.subscription-mutation",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  version: 1,
  initial: (
    _seed: null
  ): {
    receipt: {
      digest: string;
      result: { workId: string; eventId: string; subscribed: boolean };
    } | null;
  } => ({ receipt: null }),
});
const requireBinding = (
  actual: CoordinationBinding,
  expected: CoordinationBinding
) => {
  if (
    actual.ownerPrincipalId !== expected.ownerPrincipalId ||
    !sameWorkSource(actual.address, expected.address)
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The subscription belongs to another coordinator.",
    });
  }
};
const transferDependencies = (
  left: ContentDependencies,
  right: ContentDependencies
) => {
  const merged = {
    sourceIds: [...new Set([...left.sourceIds, ...right.sourceIds])],
    toolIds: [...new Set([...left.toolIds, ...right.toolIds])],
  };
  if (merged.sourceIds.length > 512 || merged.toolIds.length > 256) {
    return null;
  }
  return Schema.decodeUnknownSync(BoundedContentDependenciesSchema)(merged);
};
const keyFor = (binding: CoordinationBinding, thread: SlackThread) =>
  digestToolArguments([
    binding.address.organizationId,
    binding.ownerPrincipalId,
    binding.address.agentId,
    binding.address.conversationId,
    binding.address.sessionId,
    thread.workspaceId,
    thread.channelId,
    thread.rootTimestamp,
  ]);
const pruneThreadIn = async (
  tx: Tx,
  key: string,
  record: ThreadRecord
): Promise<void> => {
  const checked = await Promise.all(
    record.workIds.map(async (workId) => {
      const work = await tx.doc(WorkDocuments, workId, null);
      let live = false;
      if (work.record) {
        try {
          requireWorkSource(work.record, record.binding);
          live = workAcceptsEvents(work.record, Date.now());
        } catch (error) {
          if (!(error instanceof Denied)) {
            throw error;
          }
        }
      }
      if (!live) {
        const reverse = await tx.doc(WorkSubscriptions, workId, null);
        if (
          reverse.record &&
          reverse.record.binding.ownerPrincipalId ===
            record.binding.ownerPrincipalId &&
          sameWorkSource(reverse.record.binding.address, record.binding.address)
        ) {
          reverse.record.threadKeys = reverse.record.threadKeys.filter(
            (threadKey) => threadKey !== key
          );
        }
      }
      return { workId, live };
    })
  );
  const retained = checked
    .filter(({ live }) => live)
    .map(({ workId }) => workId);
  if (retained.length !== record.workIds.length) {
    record.workIds = retained;
    record.revision += 1;
  }
};
const pruneWorkIn = async (
  tx: Tx,
  workId: string,
  record: { binding: StoredBinding; threadKeys: string[] }
): Promise<void> => {
  const checked = await Promise.all(
    record.threadKeys.map(async (key) => {
      const thread = await tx.doc(ThreadSubscriptions, key, null);
      return thread.record &&
        thread.record.binding.ownerPrincipalId ===
          record.binding.ownerPrincipalId &&
        sameWorkSource(thread.record.binding.address, record.binding.address) &&
        thread.record.workIds.includes(workId)
        ? key
        : null;
    })
  );
  record.threadKeys = checked.filter((key) => key !== null);
};
const relationIn = async (
  tx: Tx,
  owner: StoredBinding,
  key: string,
  workId: string
) => {
  const threads = await tx.doc(ThreadSubscriptions, key, null);
  const works = await tx.doc(WorkSubscriptions, workId, null);
  if (threads.record) {
    requireBinding(threads.record.binding, owner);
    await pruneThreadIn(tx, key, threads.record);
  }
  if (works.record) {
    requireBinding(works.record.binding, owner);
    await pruneWorkIn(tx, workId, works.record);
  }
  return { threads, works };
};

export const createCoordinatorSubscriptions = (options: {
  readonly guardIn?: (tx: Tx) => Promise<void>;
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly coordination: ReturnType<typeof createCoordinatorWork>;
  readonly ownerContext: () => Promise<ExecutionContext>;
  readonly authorize: (context: ExecutionContext) => Promise<void>;
  readonly checkDependencies: (
    context: ExecutionContext,
    dependencies: ContentDependencies
  ) => Promise<void>;
  readonly readEvent: (
    eventId: string,
    context: ExecutionContext
  ) => Promise<BotEventReceipt>;
}) => {
  const binding = (): StoredBinding => {
    const current = options.coordination.binding();
    return {
      address: { ...current.address },
      ownerPrincipalId: current.ownerPrincipalId,
    };
  };
  const requireEvent = async (eventId: string, context: ExecutionContext) => {
    const receipt = await options.readEvent(eventId, context);
    const event = eventOf(receipt);
    if (
      receipt.digest !== (await digestToolArguments(receipt.input)) ||
      event.source.kind !== "slack"
    ) {
      throw new InvalidInput({
        reason: "A subscription requires an admitted Slack event.",
      });
    }
    if (
      event.ownerPrincipalId !== binding().ownerPrincipalId ||
      event.coordinator.organizationId !== binding().address.organizationId
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "The Slack event belongs to another identity.",
      });
    }
    return { event, thread: event.source.thread };
  };
  const mutate = async (
    workId: string,
    eventId: string,
    subscribe: boolean,
    api: Pick<ToolExecutionApi, "conversationId" | "taskId" | "commit">,
    context: Parameters<ToolExecutionApi["agent"]>[0]
  ) => {
    if (api.conversationId !== options.nativeId) {
      throw new Denied({
        code: "unauthorized",
        reason: "Only the coordinator can change subscriptions.",
      });
    }
    const caller = await options.ownerContext();
    await options.authorize(caller);
    const { thread } = await requireEvent(eventId, caller);
    const saved = await options.pi.snapshot(
      WorkDocuments,
      workId,
      piContext(context.abortSignal)
    );
    if (!saved?.record) {
      throw new NotFound({ resource: "Team work" });
    }
    requireWorkSource(saved.record, binding());
    await options.checkDependencies(
      caller,
      saved.record.admission.contentDependencies
    );
    const admitted = saved.record.admission;
    const key = await keyFor(binding(), thread);
    const digest = await digestToolArguments({
      binding: binding(),
      workId,
      eventId,
      subscribed: subscribe,
    });
    return await options.coordination.admissions.commit(
      `subscription:${api.taskId}`,
      async (tx) => {
        await options.guardIn?.(tx);
        const record = await requireCoordinatorWork(tx, binding(), workId);
        if (
          (await digestToolArguments(record.admission)) !==
          (await digestToolArguments(admitted))
        ) {
          throw new Denied({
            code: "unauthorized",
            reason: "The saved work admission changed.",
          });
        }
        const mutation = await tx.doc(
          SubscriptionMutations,
          options.nativeId,
          String(api.taskId),
          null
        );
        if (mutation.receipt) {
          if (mutation.receipt.digest !== digest) {
            throw new Conflict({
              code: "digest-mismatch",
              reason: "The subscription operation names another payload.",
            });
          }
          return { ...mutation.receipt.result };
        }
        if (subscribe && !workAcceptsEvents(record, Date.now())) {
          throw new InvalidInput({
            reason: "Only active or queued work can subscribe to a thread.",
          });
        }
        const { threads, works } = await relationIn(tx, binding(), key, workId);
        const existing = threads.record?.workIds.includes(workId) ?? false;
        const result = { workId, eventId, subscribed: subscribe };
        if (existing === subscribe) {
          mutation.receipt = { digest, result };
          return result;
        }
        const size = Math.max(
          threads.record?.workIds.length ?? 0,
          works.record?.threadKeys.length ?? 0
        );
        if (subscribe && size >= 8) {
          throw new InvalidInput({
            reason:
              "A work item and thread each support at most eight subscriptions.",
          });
        }
        threads.record ??= {
          binding: binding(),
          thread,
          admittedEventId: eventId,
          revision: 0,
          workIds: [],
        };
        works.record ??= { binding: binding(), threadKeys: [] };
        threads.record.workIds = subscribe
          ? [...threads.record.workIds, workId]
          : threads.record.workIds.filter((id) => id !== workId);
        works.record.threadKeys = subscribe
          ? [...works.record.threadKeys, key]
          : works.record.threadKeys.filter((id) => id !== key);
        threads.record.revision += 1;
        mutation.receipt = { digest, result };
        return result;
      },
      (change) => api.commit(change, context)
    );
  };

  const prepare = async (
    input: EventAdmission,
    context: ExecutionContext
  ): Promise<EventRouteIn> => {
    const { event, routing, wire } = normalizeEventAdmission(input);
    if (!options.coordination.services) {
      return () => Promise.resolve({ kind: "coordinator" });
    }
    const owner = binding();
    requireBinding(
      { address: event.coordinator, ownerPrincipalId: event.ownerPrincipalId },
      owner
    );
    await options.authorize(context);
    if (routing.kind === "direct" || routing.kind === "local-control") {
      throw new InvalidInput({
        reason: "This event does not use subscription routing.",
      });
    }
    const thread = event.source.kind === "slack" ? event.source.thread : null;
    const key = thread ? await keyFor(owner, thread) : null;
    const snapshot = key
      ? await options.pi.snapshot(ThreadSubscriptions, key, piContext())
      : null;
    if (snapshot?.record) {
      requireBinding(snapshot.record.binding, owner);
    }
    const revision = snapshot?.record?.revision ?? null;
    const ids =
      routing.kind === "control"
        ? [routing.workId]
        : (snapshot?.record?.workIds ?? []);
    const prepared = await Promise.all(
      ids.map(async (workId) => {
        const document = await options.pi.snapshot(
          WorkDocuments,
          workId,
          piContext()
        );
        if (!document?.record) {
          return { workId, kind: "missing" as const };
        }
        const { admission } = document.record;
        let dependencies: ContentDependencies;
        try {
          requireWorkSource(document.record, owner);
          const transferred =
            routing.kind === "control" && routing.action === "cancel"
              ? admission.contentDependencies
              : transferDependencies(
                  admission.contentDependencies,
                  event.dependencies
                );
          if (!transferred) {
            return { workId, kind: "full" as const };
          }
          dependencies = transferred;
          await options.checkDependencies(context, dependencies);
        } catch (error) {
          if (error instanceof Denied || error instanceof NotFound) {
            return { workId, kind: "denied" as const };
          }
          throw error;
        }
        return {
          workId,
          kind: "allowed" as const,
          admission,
          dependencies,
          digest: await digestToolArguments(admission),
        };
      })
    );
    if (
      routing.kind === "control" &&
      routing.action === "update" &&
      prepared.some((candidate) => candidate.kind === "full")
    ) {
      throw new InvalidInput({
        reason:
          "The target work cannot accept this event within its dependency limit.",
      });
    }
    const digest = await digestToolArguments(wire);
    const suffix = await coordinatorOperationKey(event.id);
    return async (tx) => {
      await options.guardIn?.(tx);
      if (key && thread) {
        const current = await tx.doc(ThreadSubscriptions, key, null);
        if (current.record) {
          requireBinding(current.record.binding, owner);
        }
        if ((current.record?.revision ?? null) !== revision) {
          throw new Unavailable({
            reason: "Thread subscriptions changed. Retry this event.",
            retryAfter: 1,
          });
        }
        current.record ??= {
          binding: owner,
          thread,
          admittedEventId: event.id,
          revision: 0,
          workIds: [],
        };
      }
      const skipped: EventSkip[] = [];
      const accepted = await Promise.all(
        prepared.map(async (candidate) => {
          if (candidate.kind !== "allowed") {
            skipped.push({ workId: candidate.workId, reason: candidate.kind });
            return null;
          }
          const document = await tx.doc(WorkDocuments, candidate.workId, null);
          if (!document.record) {
            skipped.push({ workId: candidate.workId, reason: "missing" });
            return null;
          }
          requireWorkSource(document.record, owner);
          if (
            (await digestToolArguments(document.record.admission)) !==
            candidate.digest
          ) {
            throw new Denied({
              code: "unauthorized",
              reason: "The saved work admission changed.",
            });
          }
          return {
            record: document.record,
            dependencies: candidate.dependencies,
          };
        })
      );
      const records = accepted.filter((record) => record !== null);
      if (routing.kind === "control" && routing.action === "cancel") {
        const [target] = records;
        if (!target) {
          throw new Denied({
            code: "unauthorized",
            reason: "The target work is unavailable.",
          });
        }
        const result = await options.coordination.commandIn(
          tx,
          target.record.admission.key.workId,
          event.id,
          { kind: "cancel" },
          "tool"
        );
        return {
          kind: "control",
          workId: target.record.admission.key.workId,
          status: result.status,
        };
      }
      const items = records.map(({ record, dependencies }) => ({
        record,
        command: Schema.decodeUnknownSync(TeamEventCommandSchema)({
          version: 2,
          kind: "event-command",
          command: {
            id: `event:${record.admission.key.workId}:${suffix}`,
            kind: "input",
            work: record.admission,
            text: event.content.text,
            contentDependencies: dependencies,
          },
          event: {
            id: event.id,
            digest,
            source: event.source,
            replyTo: event.replyTo,
          },
        }),
      }));
      const routed = await options.coordination.eventCommandsIn(tx, items);
      skipped.push(...routed.skipped);
      return routed.recipients.length > 0
        ? { kind: "teams", recipients: routed.recipients, skipped }
        : { kind: "coordinator", skipped };
    };
  };
  const tools = options.coordination.services
    ? [true, false].map((subscribe) =>
        defineTool({
          name: subscribe ? "subscribe_work" : "unsubscribe_work",
          callers: ["model"],
          replay: "safe",
          description: subscribe
            ? "Route future events from a previously admitted Slack event's thread to this work. Requires an owned event ID and work ID."
            : "Remove this work's explicit subscription to a previously admitted Slack event's thread.",
          parameters: Type.Object({
            eventId: Type.String({ minLength: 1, maxLength: 512 }),
            workId: Type.String({ minLength: 1, maxLength: 512 }),
          }),
          execute: ({ workId, eventId }, api, context) =>
            coordinationToolResult(() =>
              mutate(workId, eventId, subscribe, api, context)
            ),
        })
      )
    : [];
  return {
    prepare,
    tools,
    subscribe: (
      workId: string,
      eventId: string,
      api: Pick<ToolExecutionApi, "conversationId" | "taskId" | "commit">,
      context: Parameters<ToolExecutionApi["agent"]>[0]
    ) => mutate(workId, eventId, true, api, context),
    unsubscribe: (
      workId: string,
      eventId: string,
      api: Pick<ToolExecutionApi, "conversationId" | "taskId" | "commit">,
      context: Parameters<ToolExecutionApi["agent"]>[0]
    ) => mutate(workId, eventId, false, api, context),
  };
};

export const listSubscribedBotSources = async (options: {
  readonly pi: Harness;
  readonly thread: SlackThread;
  readonly context: ExecutionContext;
  readonly authorize: (
    binding: CoordinationBinding,
    dependencies: ContentDependencies
  ) => Promise<void>;
}) => {
  const ledger = await options.pi.snapshot(WorkLedger, piContext());
  const principal = options.context.represented ?? options.context.actor;
  if (!ledger?.identity) {
    return [];
  }
  if (
    ledger.identity.organizationId !== principal.organizationId ||
    ledger.identity.ownerPrincipalId !== principal.id
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The subscription ledger belongs to another identity.",
    });
  }
  const candidates = [
    ...Object.entries(ledger.active).map(([workId, value]) => ({
      workId,
      ...value,
    })),
    ...ledger.queue,
  ];
  const sources = await Promise.all(
    candidates.map(async ({ workId, source, deadlineAt }) => {
      if (deadlineAt <= Date.now()) {
        return null;
      }
      const owner = { address: source, ownerPrincipalId: principal.id };
      const document = await options.pi.snapshot(
        WorkDocuments,
        workId,
        piContext()
      );
      if (!document?.record) {
        return null;
      }
      const { record } = document;
      requireWorkSource(record, owner);
      if (!workAcceptsEvents(record, Date.now())) {
        return null;
      }
      const subscriptions = await options.pi.snapshot(
        ThreadSubscriptions,
        await keyFor(owner, options.thread),
        piContext()
      );
      if (!subscriptions?.record?.workIds.includes(workId)) {
        return null;
      }
      requireBinding(subscriptions.record.binding, owner);
      try {
        await options.authorize(owner, record.admission.contentDependencies);
      } catch (error) {
        if (error instanceof Denied || error instanceof NotFound) {
          return null;
        }
        throw error;
      }
      return source;
    })
  );
  const unique = new Map<string, BotEvent["coordinator"]>();
  for (const source of sources) {
    if (source) {
      unique.set(
        JSON.stringify([
          source.organizationId,
          source.agentId,
          source.conversationId,
          source.sessionId,
        ]),
        source
      );
    }
  }
  return [...unique.values()];
};
