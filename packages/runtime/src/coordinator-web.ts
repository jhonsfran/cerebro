import { botEventId } from "@cerebro/contracts/bot-events";
import type { BotEvent } from "@cerebro/contracts/bot-events";
import { Conflict, Denied, Unavailable } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { ChatReceipt } from "@cerebro/contracts/session-service";
import { InboxDoc } from "@earendil-works/pi-durable";
import type { Conversation, Harness, Tx } from "@earendil-works/pi-durable";
import { Effect } from "effect";

import type { createConversationResources } from "./conversation-resources.ts";
import type { CoordinatorEvents, EventRouteIn } from "./coordinator-events.ts";
import {
  SourceOperations,
  WorkDocuments,
  WorkLedger,
  coordinatorOperationKey,
  requireWorkSource,
  sameWorkSource,
} from "./coordinator-ledger.ts";
import type { CoordinatorWorkRecord } from "./coordinator-ledger.ts";
import { appendPassiveAnswer } from "./passive-history.ts";
import { piContext } from "./pi-harness.ts";
import type { SessionHostConfiguration } from "./session-agent.ts";

const sourceWorkIdsIn = async (tx: Tx, event: BotEvent): Promise<string[]> => {
  const ledger = await tx.doc(WorkLedger);
  if (
    ledger.identity &&
    (ledger.identity.organizationId !== event.coordinator.organizationId ||
      ledger.identity.ownerPrincipalId !== event.ownerPrincipalId)
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The work belongs to another identity.",
    });
  }
  return [
    ...Object.entries(ledger.active).map(([workId, item]) => ({
      workId,
      ...item,
    })),
    ...ledger.queue,
  ]
    .filter((item) => sameWorkSource(item.source, event.coordinator))
    .map((item) => item.workId)
    .toSorted();
};
const dependenciesOf = (
  records: readonly CoordinatorWorkRecord[]
): ContentDependencies => ({
  sourceIds: [
    ...new Set(
      records.flatMap(
        (record) => record.admission.contentDependencies.sourceIds
      )
    ),
  ],
  toolIds: [
    ...new Set(
      records.flatMap((record) => record.admission.contentDependencies.toolIds)
    ),
  ],
});

export const createCoordinatorWeb = (options: {
  readonly pi: Harness;
  readonly native: Conversation;
  readonly events: CoordinatorEvents;
  readonly runtime: Pick<
    ReturnType<typeof createConversationResources>,
    "authorize"
  > &
    Partial<Pick<ReturnType<typeof createConversationResources>, "guardIn">> & {
      readonly configuration: Pick<
        SessionHostConfiguration,
        "address" | "agent" | "ownerContext" | "checkDependencies"
      > & {
        readonly provider: Pick<SessionHostConfiguration["provider"], "model">;
      };
    };
  readonly replayHandled: (
    operationId: string,
    text: string,
    context: ExecutionContext,
    signal?: AbortSignal
  ) => Promise<boolean>;
}) => {
  const { pi, native, runtime } = options;
  const prepareLocalControl = async (
    event: BotEvent,
    action: "status" | "stop",
    context: ExecutionContext
  ): Promise<EventRouteIn> => {
    await runtime.authorize(context, "coordinate");
    await runtime.authorize(context, "transfer");
    const ids = await pi.commit(
      (tx) => sourceWorkIdsIn(tx, event),
      piContext()
    );
    const documents = await Promise.all(
      ids.map((workId) => pi.snapshot(WorkDocuments, workId, piContext()))
    );
    const prepared = {
      ids,
      records: documents.flatMap((document) =>
        document?.record ? [document.record] : []
      ),
    };
    for (const record of prepared.records) {
      requireWorkSource(record, {
        address: event.coordinator,
        ownerPrincipalId: event.ownerPrincipalId,
      });
    }
    await Effect.runPromise(
      runtime.configuration.checkDependencies(
        context,
        dependenciesOf(prepared.records),
        {
          deadlineAt: Date.now() + 30_000,
        }
      )
    );
    return async (tx) => {
      await runtime.guardIn?.(tx);
      const currentIds = await sourceWorkIdsIn(tx, event);
      if (JSON.stringify(currentIds) !== JSON.stringify(prepared.ids)) {
        throw new Unavailable({
          reason: "Team work changed. Retry this control.",
          retryAfter: 1,
        });
      }
      const records = await Promise.all(
        currentIds.map(async (workId) => {
          const document = await tx.doc(WorkDocuments, workId, null);
          const before = prepared.records.find(
            (record) => record.admission.key.workId === workId
          );
          if (
            !document.record ||
            !before ||
            JSON.stringify(document.record.admission) !==
              JSON.stringify(before.admission)
          ) {
            throw new Unavailable({
              reason: "Team work changed. Retry this control.",
              retryAfter: 1,
            });
          }
          return document.record;
        })
      );
      const statuses = records
        .map(
          (record) => `${record.admission.key.workId}: ${record.status.kind}`
        )
        .join("\n");
      let answer =
        statuses ||
        "There is no active or queued team work in this conversation.";
      if (action === "stop" && records.length > 0) {
        answer = `Choose a work ID and use stop_work to cancel it.\n${statuses}`;
      }
      await tx.appendEntry(native.id, {
        kind: "cerebro.bot-event-input",
        data: {
          eventId: event.id,
          source: event.source.kind,
          agentVersion: runtime.configuration.agent.version,
          ...(event.source.kind === "web"
            ? { operationId: event.source.operationId }
            : {}),
        },
        model: [
          { role: "user", content: event.content.text, timestamp: Date.now() },
        ],
      });
      const entry = await appendPassiveAnswer(
        tx,
        native.id,
        answer,
        runtime.configuration.provider.model
      );
      return { kind: "local-answer", action, answerEntryId: entry.id };
    };
  };

  const send = async (
    operationId: string,
    text: string,
    context: ExecutionContext,
    signal?: AbortSignal
  ): Promise<ChatReceipt> => {
    const key = await coordinatorOperationKey(operationId);
    const previous = await pi.snapshot(
      SourceOperations,
      native.id,
      key,
      piContext(signal)
    );
    const submission = await pi.commit(
      (tx) => tx.submissionByRequest(native.id, operationId),
      piContext(signal)
    );
    if (
      submission ||
      (previous?.route && previous.route.kind !== "coordinator")
    ) {
      await runtime.authorize(context, "coordinate", signal);
      await runtime.authorize(context, "transfer", signal);
      if (
        previous?.digest &&
        previous.digest !== (await coordinatorOperationKey(text))
      ) {
        throw new Conflict({
          code: "digest-mismatch",
          reason: "The source operation payload changed.",
        });
      }
      const replay = await pi.commit(async (tx) => {
        const current = await tx.submissionByRequest(native.id, operationId);
        if (!current) {
          return;
        }
        if (current.type !== "input") {
          throw new Conflict({
            code: "digest-mismatch",
            reason: "The source operation identifies a native write.",
          });
        }
        let original: unknown;
        if (current.status === "queued") {
          const inbox = await tx.doc(InboxDoc, native.id);
          const item = inbox.items.find(
            (candidate) => candidate.id === current.id
          );
          original = item && item.mode !== "write" ? item.content : undefined;
        } else if (current.entry !== undefined) {
          const entry = await tx.entry(current.entry);
          const message = entry?.model?.[0];
          original = message?.role === "user" ? message.content : undefined;
        }
        if (original !== undefined && original !== text) {
          throw new Conflict({
            code: "digest-mismatch",
            reason: "The source operation payload changed.",
          });
        }
        return current;
      }, piContext(signal));
      if (!replay) {
        await options.replayHandled(operationId, text, context, signal);
      }
      return {
        accepted: replay === undefined,
        operationId,
        session: String(native.id),
      };
    }
    const local = text === "status" || text === "stop";
    const owner = await Effect.runPromise(runtime.configuration.ownerContext());
    const source = {
      kind: "web",
      operationId: id.operation(operationId),
    } as const;
    const event: BotEvent = {
      version: 1,
      id: await botEventId(runtime.configuration.address, source),
      coordinator: runtime.configuration.address,
      ownerPrincipalId: owner.represented?.id ?? owner.actor.id,
      source,
      replyTo: { kind: "web", address: runtime.configuration.address },
      content: { text, reference: null },
      dependencies: { sourceIds: [], toolIds: [] },
    };
    const admitted = await options.events.admit(
      {
        version: 2,
        kind: "event-admission",
        event,
        routing: local
          ? { kind: "local-control", action: text }
          : { kind: "automatic" },
      },
      context
    );
    return {
      accepted: local || admitted.duplicates === 0,
      operationId,
      session: String(native.id),
    };
  };
  return { send, prepareLocalControl };
};
