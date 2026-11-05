import { Conflict } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { Conversation, Harness } from "@earendil-works/pi-durable";

import type { createConversationResources } from "./conversation-resources.ts";
import {
  SourceOperations,
  WorkLedger,
  pruneWorkIndex,
  coordinatorOperationKey,
  requireCoordinatorWork,
  sameWorkSource,
} from "./coordinator-ledger.ts";
import type { createCoordinatorWork } from "./coordinator-work.ts";
import { appendPassiveAnswer, appendPassiveUser } from "./passive-history.ts";
import { piContext } from "./pi-harness.ts";
import type { SessionHostConfiguration } from "./session-agent.ts";

export const createCoordinatorSource =
  (options: {
    readonly pi: Harness;
    readonly native: Conversation;
    readonly runtime: Pick<
      ReturnType<typeof createConversationResources>,
      "authorize"
    > & {
      readonly configuration: Pick<SessionHostConfiguration, "coordination"> & {
        readonly provider: Pick<SessionHostConfiguration["provider"], "model">;
      };
    };
    readonly coordination: ReturnType<typeof createCoordinatorWork>;
    readonly notify: () => Promise<void>;
  }) =>
  async (
    operationId: string,
    text: string,
    context: ExecutionContext,
    signal?: AbortSignal
  ): Promise<boolean> => {
    const { runtime, coordination, native } = options;
    const services = runtime.configuration.coordination;
    if (!services) {
      return false;
    }
    await runtime.authorize(context, "coordinate", signal);
    const key = await coordinatorOperationKey(operationId);
    const digest = await coordinatorOperationKey(text);
    const previous = await options.pi.snapshot(
      SourceOperations,
      native.id,
      key,
      piContext(signal)
    );
    if (previous?.route) {
      if (previous.digest !== null && previous.digest !== digest) {
        throw new Conflict({
          code: "digest-mismatch",
          reason: "The source operation payload changed.",
        });
      }
      const handled = previous.route.kind !== "coordinator";
      if (handled) {
        await options.notify();
      }
      return handled;
    }
    const control = text === "status" || text === "stop";
    const handled = await coordination.admissions.commit(
      operationId,
      async (tx) => {
        const operation = await tx.doc(
          SourceOperations,
          native.id,
          key,
          operationId
        );
        if (operation.digest !== null && operation.digest !== digest) {
          throw new Conflict({
            code: "digest-mismatch",
            reason: "The source operation payload changed.",
          });
        }
        operation.digest = digest;
        if (operation.route) {
          return operation.route.kind !== "coordinator";
        }
        if (await tx.submissionByRequest(native.id, operationId)) {
          operation.route = { kind: "coordinator", workId: null };
          return false;
        }
        const ledger = await tx.doc(WorkLedger);
        await pruneWorkIndex(tx, ledger, Date.now());
        if (control) {
          const entries = [
            ...Object.entries(ledger.active).map(([workId, entry]) => ({
              workId,
              ...entry,
            })),
            ...(ledger.queue ?? []),
          ].filter((entry) =>
            sameWorkSource(entry.source, coordination.binding().address)
          );
          const records = await Promise.all(
            entries.map((entry) =>
              requireCoordinatorWork(tx, coordination.binding(), entry.workId)
            )
          );
          operation.route = { kind: "handled", workId: null };
          await appendPassiveUser(tx, native.id, text);
          const statuses = records
            .map(
              (record) =>
                `${record.admission.key.workId}: ${record.status.kind}`
            )
            .join("\n");
          let answer =
            statuses ||
            "There is no active or queued team work in this conversation.";
          if (text === "stop" && records.length > 0) {
            answer = `Choose a work ID and use stop_work to cancel it.\n${statuses}`;
          }
          await appendPassiveAnswer(
            tx,
            native.id,
            answer,
            runtime.configuration.provider.model
          );
          return true;
        }
        operation.route = { kind: "coordinator", workId: null };
        return false;
      }
    );
    if (handled) {
      await options.notify();
    }
    return handled;
  };
