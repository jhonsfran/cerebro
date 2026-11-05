import { BotEventSchema, botEventId } from "@cerebro/contracts/bot-events";
import type { BotEvent } from "@cerebro/contracts/bot-events";
import type { WorkReport } from "@cerebro/contracts/work";
import type { Tx } from "@earendil-works/pi-durable";
import { Schema } from "effect";

import type { CoordinatorEvents } from "./coordinator-events.ts";
import type { CoordinatorWorkRecord } from "./coordinator-ledger.ts";

export type TerminalNoticeIn = (
  tx: Tx,
  record: CoordinatorWorkRecord,
  reason: "expired" | "dispatch-failed"
) => Promise<void>;
export const coordinatorWorkEvent = async (
  record: CoordinatorWorkRecord,
  source: Extract<
    BotEvent["source"],
    { kind: "teamreport" | "coordinator-terminalnotice" }
  >,
  text: string,
  dependencies = record.admission.contentDependencies
): Promise<BotEvent> =>
  Schema.decodeUnknownSync(BotEventSchema)({
    version: 1,
    id: await botEventId(record.admission.sourceEventAddress, source),
    coordinator: record.admission.sourceEventAddress,
    ownerPrincipalId: record.admission.key.ownerPrincipalId,
    source,
    replyTo: null,
    content: {
      text: text.slice(0, 2000),
      reference: { kind: "work", key: record.admission.key },
    },
    dependencies,
  });
export const coordinatorReportEvent = (
  record: CoordinatorWorkRecord,
  report: WorkReport
): Promise<BotEvent> => {
  let text = "Team work cancelled.";
  if (report.kind === "completed") {
    ({ text } = report);
  }
  if (report.kind === "failed") {
    text = report.reason;
  }
  return coordinatorWorkEvent(
    record,
    {
      kind: "teamreport",
      key: report.key,
      reportId: report.id,
      outcome: report.kind,
    },
    text,
    report.contentDependencies
  );
};

export const terminalNoticeIn =
  (events: CoordinatorEvents): TerminalNoticeIn =>
  async (tx, record, reason) => {
    await events.enqueueIn(
      tx,
      await coordinatorWorkEvent(
        record,
        {
          kind: "coordinator-terminalnotice",
          key: record.admission.key,
          reason,
        },
        reason === "expired"
          ? "The team work deadline expired."
          : "The team command could not be delivered."
      )
    );
  };
