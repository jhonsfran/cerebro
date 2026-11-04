import { Conflict } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { Conversation, Harness } from "@earendil-works/pi-durable";

import type { createConversationResources } from "./conversation-resources.ts";
import {
  SourceOperations,
  SourceWork,
  WorkLedger,
  pruneWorkIndex,
  coordinatorOperationKey,
  requireCoordinatorWork,
  workHoldsSlot,
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
    const dependencies = control
      ? { sourceIds: [], toolIds: [] }
      : await services.contentDependencies();
    if (!control) {
      await runtime.authorize(context, "transfer", signal);
    }
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
        const source = await tx.doc(SourceWork, native.id);
        const record = source.workId
          ? await requireCoordinatorWork(
              tx,
              coordination.binding(),
              source.workId
            )
          : undefined;
        if (control) {
          if (text === "stop" && record && workHoldsSlot(record, Date.now())) {
            await coordination.commandIn(
              tx,
              record.admission.key.workId,
              operationId,
              { kind: "cancel" }
            );
          }
          operation.route = { kind: "handled", workId: source.workId };
          await appendPassiveUser(tx, native.id, text);
          const answer = record
            ? `Team work ${record.status.kind}.`
            : "There is no team work in this thread.";
          await appendPassiveAnswer(
            tx,
            native.id,
            answer,
            runtime.configuration.provider.model
          );
          return true;
        }
        if (record && workHoldsSlot(record, Date.now())) {
          if (
            record.status.kind === "accepted" ||
            record.status.kind === "running"
          ) {
            await coordination.commandIn(
              tx,
              record.admission.key.workId,
              operationId,
              {
                kind: "input",
                text,
                contentDependencies: dependencies,
              }
            );
            await appendPassiveUser(tx, native.id, text);
          } else {
            await appendPassiveUser(tx, native.id, text);
            operation.route = { kind: "handled", workId: source.workId };
            await appendPassiveAnswer(
              tx,
              native.id,
              "This team work no longer accepts input.",
              runtime.configuration.provider.model
            );
          }
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
