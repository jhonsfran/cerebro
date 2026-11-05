import { NotFound } from "@cerebro/contracts/failures";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type {
  Cursor,
  ConversationId,
  Harness,
  ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import {
  WorkDocuments,
  retainedWorkDependencies,
  requireWorkSource,
  sameWorkSource,
} from "./coordinator-ledger.ts";
import type {
  CoordinationBinding,
  CoordinatorWorkRecord,
} from "./coordinator-ledger.ts";
import {
  importContentIn,
  reconcileImportedContent,
} from "./imported-content.ts";
import { piContext } from "./pi-harness.ts";

export type ScanWorkKeys = (cursor?: Cursor) => Promise<{
  readonly keys: readonly string[];
  readonly next?: Cursor;
}>;
export interface WorkContentAccess {
  readonly check: (
    dependencies: ContentDependencies,
    signal?: AbortSignal
  ) => Promise<void>;
  readonly retain: (dependencies: ContentDependencies) => void;
}
const cursorSchema = Schema.fromJsonString(
  Schema.declare<Cursor>((value): value is Cursor =>
    Schema.is(Schema.JsonObject)(value)
  )
);
const boundedStatus = (record: CoordinatorWorkRecord) =>
  record.status.kind === "failed"
    ? { ...record.status, reason: record.status.reason.slice(0, 400) }
    : record.status;

export const createCoordinatorHistory = (options: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly binding: () => CoordinationBinding;
  readonly scanWorkKeys: ScanWorkKeys;
  readonly contentAccess: WorkContentAccess;
}) => {
  const retain = async (
    records: readonly CoordinatorWorkRecord[],
    api: Pick<ToolExecutionApi, "commit">,
    context: Parameters<ToolExecutionApi["agent"]>[0]
  ): Promise<void> => {
    const dependencies = retainedWorkDependencies(records);
    await options.contentAccess.check(dependencies, context.abortSignal);
    await api.commit(async (tx) => {
      await importContentIn(tx, options.nativeId, dependencies);
    }, context);
    await reconcileImportedContent(
      options.pi,
      options.nativeId,
      options.contentAccess.retain,
      { signal: context.abortSignal }
    );
  };
  return {
    list: async (
      cursor: string | undefined,
      api: Pick<ToolExecutionApi, "commit">,
      context: Parameters<ToolExecutionApi["agent"]>[0]
    ) => {
      const page = await options.scanWorkKeys(
        cursor ? Schema.decodeUnknownSync(cursorSchema)(cursor) : undefined
      );
      const documents = await Promise.all(
        page.keys.map((key) =>
          options.pi.snapshot(
            WorkDocuments,
            key,
            piContext(context.abortSignal)
          )
        )
      );
      const binding = options.binding();
      const records = documents.flatMap((document) =>
        document?.record &&
        sameWorkSource(
          document.record.admission.sourceEventAddress,
          binding.address
        )
          ? [document.record]
          : []
      );
      for (const record of records) {
        requireWorkSource(record, binding);
      }
      await retain(records, api, context);
      return {
        items: records.map((record) => ({
          workId: record.admission.key.workId,
          goal: record.admission.goal.slice(0, 160),
          status: boundedStatus(record),
          deadlineAt: record.admission.deadlineAt,
        })),
        ...(page.next ? { next: JSON.stringify(page.next) } : {}),
      };
    },
    recall: async (
      workId: string,
      api: Pick<ToolExecutionApi, "commit">,
      context: Parameters<ToolExecutionApi["agent"]>[0],
      offset = 0
    ) => {
      const document = await options.pi.snapshot(
        WorkDocuments,
        workId,
        piContext(context.abortSignal)
      );
      if (!document?.record) {
        throw new NotFound({ resource: "Team work" });
      }
      requireWorkSource(document.record, options.binding());
      await retain([document.record], api, context);
      let report = document.record.terminalReport;
      const reportTruncated =
        (report?.kind === "completed" && report.text.length > offset + 4000) ||
        (report?.kind === "failed" && report.reason.length > offset + 4000);
      if (report?.kind === "completed") {
        report = { ...report, text: report.text.slice(offset, offset + 4000) };
      }
      if (report?.kind === "failed") {
        report = {
          ...report,
          reason: report.reason.slice(offset, offset + 4000),
        };
      }
      return {
        workId: document.record.admission.key.workId,
        goal: document.record.admission.goal.slice(0, 4000),
        status: boundedStatus(document.record),
        deadlineAt: document.record.admission.deadlineAt,
        report,
        reportTruncated,
        reportOffset: offset,
        ...(reportTruncated ? { nextReportOffset: offset + 4000 } : {}),
      };
    },
  };
};
