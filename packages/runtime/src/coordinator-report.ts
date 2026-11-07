import { Conflict, Denied } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import {
  TeamReportReceiptSchema,
  TeamReportDeliverySchema,
} from "@cerebro/contracts/work";
import type { TeamReportDelivery } from "@cerebro/contracts/work";
import { defineDocFamily } from "@earendil-works/pi-durable";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { Effect, Result, Schema } from "effect";

import type { createConversationResources } from "./conversation-resources.ts";
import { reportTriggerIn } from "./coordinator-event-content.ts";
import {
  applyCoordinatorReport,
  WorkDocuments,
  coordinatorOperationKey,
  requireCoordinatorWork,
  requireWorkSource,
  sameWorkSource,
} from "./coordinator-ledger.ts";
import type {
  CoordinationBinding,
  CoordinatorWorkRecord,
} from "./coordinator-ledger.ts";
import type { createCoordinatorWork } from "./coordinator-work.ts";
import {
  importContentIn,
  reconcileImportedContent,
} from "./imported-content.ts";
import { piContext } from "./pi-harness.ts";
import type { SessionHostConfiguration } from "./session-agent.ts";
import type { Triggers } from "./triggers.ts";

export const SourceReportReceipts = defineDocFamily({
  kind: "cerebro.coordinator-report",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  version: 1,
  initial: (
    _seed: null
  ): { receipt: { digest: string; accepted: boolean } | null } => ({
    receipt: null,
  }),
});
const run = async (
  program: Effect.Effect<void, ContractFailure>
): Promise<void> => {
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(result)) {
    throw result.failure;
  }
};
const requireReportSource = (
  record: CoordinatorWorkRecord,
  delivery: TeamReportDelivery,
  binding: CoordinationBinding
): void => {
  requireWorkSource(record, binding);
  const { admission } = record;
  if (
    !sameWorkSource(
      admission.sourceEventAddress,
      delivery.sourceEventAddress
    ) ||
    admission.key.organizationId !== delivery.report.key.organizationId ||
    admission.key.ownerPrincipalId !== delivery.report.key.ownerPrincipalId ||
    admission.key.workId !== delivery.report.key.workId
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The saved report source changed.",
    });
  }
};
export const createCoordinatorReport =
  (options: {
    readonly pi: Harness;
    readonly native: Conversation;
    readonly runtime: Pick<
      ReturnType<typeof createConversationResources>,
      "authorize"
    > &
      Partial<
        Pick<ReturnType<typeof createConversationResources>, "guardIn">
      > & {
        readonly configuration: Pick<
          SessionHostConfiguration,
          "coordination" | "checkImportedDependencies" | "importDependencies"
        > & {
          readonly provider: Pick<
            SessionHostConfiguration["provider"],
            "model"
          >;
        };
      };
    readonly coordination: ReturnType<typeof createCoordinatorWork>;
    readonly triggers: Pick<Triggers, "acceptIn" | "drain">;
    readonly persist: () => Promise<void>;
    readonly waitUntil: (promise: Promise<unknown>) => void;
  }) =>
  async (
    input: TeamReportDelivery,
    context: ExecutionContext,
    signal?: AbortSignal
  ) => {
    const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema, {
      onExcessProperty: "error",
    })(input);
    const { report } = delivery;
    const { configuration } = options.runtime;
    const { checkImportedDependencies, importDependencies } = configuration;
    if (!configuration.coordination) {
      throw new Denied({
        code: "revoked",
        reason: "The report source is not configured.",
      });
    }
    const binding = options.coordination.binding();
    if (!sameWorkSource(delivery.sourceEventAddress, binding.address)) {
      throw new Denied({
        code: "unauthorized",
        reason: "The report source changed.",
      });
    }
    const digest = await coordinatorOperationKey(
      canonicalToolArguments(delivery)
    );
    const key = await coordinatorOperationKey(
      JSON.stringify([report.key, report.id])
    );
    await options.runtime.authorize(context, "coordinate", signal);
    const saved = await options.pi.snapshot(
      WorkDocuments,
      report.key.workId,
      piContext(signal)
    );
    const previous = saved?.record;
    if (previous) {
      requireReportSource(previous, delivery, binding);
    }
    const admitsContent =
      previous !== null &&
      previous !== undefined &&
      previous.reportId === null &&
      previous.admission.deadlineAt > Date.now() &&
      (previous.status.kind === "accepted" ||
        previous.status.kind === "running");
    if (admitsContent) {
      if (!checkImportedDependencies || !importDependencies) {
        throw new Denied({
          code: "revoked",
          reason: "The report import ports are not configured.",
        });
      }
      await options.runtime.authorize(context, "transfer", signal);
      await run(
        checkImportedDependencies(context, report.contentDependencies, {
          deadlineAt: Date.now() + 30_000,
          signal,
        })
      );
    }
    const result = await options.coordination.admissions.commit(
      `report:${key}`,
      async (tx) => {
        await options.runtime.guardIn?.(tx);
        const record = await requireCoordinatorWork(
          tx,
          binding,
          report.key.workId
        );
        requireReportSource(record, delivery, binding);
        const document = await tx.doc(
          SourceReportReceipts,
          options.native.id,
          key,
          null
        );
        if (document.receipt) {
          if (document.receipt.digest !== digest) {
            throw new Conflict({
              code: "digest-mismatch",
              reason: "The report ID names another payload.",
            });
          }
          return document.receipt.accepted;
        }
        const applied = await applyCoordinatorReport(
          tx,
          binding,
          report,
          async (transaction, value) => {
            if (!admitsContent || !importDependencies) {
              throw new Denied({
                code: "revoked",
                reason: "The report was not authorized for import.",
              });
            }
            await importContentIn(
              transaction,
              options.native.id,
              value.contentDependencies
            );
            await options.triggers.acceptIn(
              transaction,
              await reportTriggerIn(transaction, record, value)
            );
          },
          Date.now(),
          (transaction, expired) =>
            options.coordination.notifyExpiredIn(transaction, [expired])
        );
        document.receipt = { digest, accepted: applied.accepted };
        return applied.accepted;
      }
    );
    if (result && importDependencies) {
      await reconcileImportedContent(
        options.pi,
        options.native.id,
        importDependencies,
        { signal }
      );
    }
    if (result) {
      options.waitUntil(options.triggers.drain(options.native.id));
    }
    await options.persist();
    return Schema.decodeUnknownSync(TeamReportReceiptSchema)({
      reportId: report.id,
      key: report.key,
      accepted: result,
    });
  };
