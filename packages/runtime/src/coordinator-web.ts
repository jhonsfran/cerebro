import { Conflict, Denied, Unavailable } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { ChatReceipt } from "@cerebro/contracts/session-service";
import {
  TRIGGER_ENTRY_KIND,
  triggerEntryData,
  triggerId,
} from "@cerebro/contracts/triggers";
import type { Trigger } from "@cerebro/contracts/triggers";
import type { Conversation, Harness, Tx } from "@earendil-works/pi-durable";
import { Effect } from "effect";

import type { createConversationResources } from "./conversation-resources.ts";
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
import { prepareReply } from "./replies.ts";
import type { ReplyOutbox, ReplyScope } from "./replies.ts";
import type { SessionHostConfiguration } from "./session-agent.ts";
import type { RouteIn, Triggers } from "./triggers.ts";

const sourceWorkIdsIn = async (tx: Tx, trigger: Trigger): Promise<string[]> => {
  const ledger = await tx.doc(WorkLedger);
  if (
    ledger.identity &&
    (ledger.identity.organizationId !== trigger.address.organizationId ||
      ledger.identity.ownerPrincipalId !== trigger.ownerPrincipalId)
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
    .filter((item) => sameWorkSource(item.source, trigger.address))
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
  readonly triggers: Pick<Triggers, "admit">;
  readonly replies: Pick<ReplyOutbox, "enqueueIn">;
  readonly replyScope: ReplyScope;
  readonly runtime: Pick<
    ReturnType<typeof createConversationResources>,
    "authorize"
  > &
    Partial<Pick<ReturnType<typeof createConversationResources>, "guardIn">> & {
      readonly configuration: Pick<
        SessionHostConfiguration,
        | "address"
        | "agent"
        | "ownerContext"
        | "checkDependencies"
        | "contentDependencies"
      > & {
        readonly provider: Pick<SessionHostConfiguration["provider"], "model">;
      };
    };
}) => {
  const { pi, native, runtime } = options;
  const localAnswer = async (
    trigger: Trigger,
    action: "status" | "stop",
    context: ExecutionContext
  ): Promise<RouteIn> => {
    await runtime.authorize(context, "coordinate");
    await runtime.authorize(context, "transfer");
    const ids = await pi.commit(
      (tx) => sourceWorkIdsIn(tx, trigger),
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
        address: trigger.address,
        ownerPrincipalId: trigger.ownerPrincipalId,
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
    const reply = trigger.reply
      ? await prepareReply({
          trigger,
          scope: options.replyScope,
          recorded: (await runtime.configuration.contentDependencies?.()) ?? {
            sourceIds: [],
            toolIds: [],
          },
        })
      : undefined;
    return async (tx) => {
      await runtime.guardIn?.(tx);
      const currentIds = await sourceWorkIdsIn(tx, trigger);
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
        kind: TRIGGER_ENTRY_KIND,
        data: triggerEntryData(trigger),
        model: [{ role: "user", content: trigger.text, timestamp: Date.now() }],
      });
      const entry = await appendPassiveAnswer(
        tx,
        native.id,
        answer,
        runtime.configuration.provider.model
      );
      if (reply) {
        await options.replies.enqueueIn(tx, {
          trigger,
          nativeId: native.id,
          text: answer,
          dependencies: reply.dependencies,
          blocked: reply.blocked,
        });
      }
      return { kind: "local-answer", action, answerEntry: entry.id };
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
    if (previous?.route && previous.route.kind !== "coordinator") {
      await runtime.authorize(context, "coordinate", signal);
      if (previous.digest !== (await coordinatorOperationKey(text))) {
        throw new Conflict({
          code: "digest-mismatch",
          reason: "The source operation payload changed.",
        });
      }
      return { accepted: true, operationId, session: String(native.id) };
    }
    const local = text === "status" || text === "stop";
    const owner = await Effect.runPromise(runtime.configuration.ownerContext());
    const { address } = runtime.configuration;
    const origin = {
      kind: "web",
      operationId: id.operation(operationId),
    } as const;
    const trigger: Trigger = {
      version: 2,
      id: await triggerId(address, origin),
      address,
      ownerPrincipalId: owner.represented?.id ?? owner.actor.id,
      origin,
      text,
      reference: null,
      reply: null,
      dependencies: { sourceIds: [], toolIds: [] },
    };
    const admitted = await options.triggers.admit(
      {
        version: 3,
        kind: "trigger-admission",
        trigger,
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
  return { send, localAnswer };
};
