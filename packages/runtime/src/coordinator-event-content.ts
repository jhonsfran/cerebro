import type { ContentDependencies } from "@cerebro/contracts/session";
import { TriggerSchema, triggerId } from "@cerebro/contracts/triggers";
import type { Trigger, TriggerOrigin } from "@cerebro/contracts/triggers";
import type { WorkReport } from "@cerebro/contracts/work";
import type { Tx } from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { sameWorkSource } from "./coordinator-ledger.ts";
import type { CoordinatorWorkRecord } from "./coordinator-ledger.ts";
import { Receipts } from "./trigger-receipts.ts";
import type { Triggers } from "./triggers.ts";

export type TerminalNoticeIn = (
  tx: Tx,
  record: CoordinatorWorkRecord,
  reason: "expired" | "dispatch-failed"
) => Promise<void>;

/** The cause trigger's destination, so a Team's report answers in the thread that started the work. */
const causeReplyIn = async (
  tx: Tx,
  record: CoordinatorWorkRecord
): Promise<Trigger["reply"]> => {
  if (!record.humanOperationId) {
    return null;
  }
  const cause = await tx.doc(Receipts, record.humanOperationId, null);
  const trigger = cause.receipt?.trigger;
  if (
    !trigger ||
    trigger.ownerPrincipalId !== record.admission.key.ownerPrincipalId ||
    !sameWorkSource(trigger.address, record.admission.sourceEventAddress)
  ) {
    return null;
  }
  return trigger.reply;
};
export const teamTriggerIn = async (
  tx: Tx,
  record: CoordinatorWorkRecord,
  origin: Extract<TriggerOrigin, { kind: "teamreport" | "teamnotice" }>,
  text: string,
  dependencies: ContentDependencies = record.admission.contentDependencies
): Promise<Trigger> =>
  Schema.decodeUnknownSync(TriggerSchema)({
    version: 2,
    id: await triggerId(record.admission.sourceEventAddress, origin),
    address: record.admission.sourceEventAddress,
    ownerPrincipalId: record.admission.key.ownerPrincipalId,
    origin,
    text: text.slice(0, 2000),
    reference: { kind: "work", key: record.admission.key },
    reply: await causeReplyIn(tx, record),
    dependencies,
  });
export const reportTriggerIn = (
  tx: Tx,
  record: CoordinatorWorkRecord,
  report: WorkReport
): Promise<Trigger> => {
  let text = "Team work cancelled.";
  if (report.kind === "completed") {
    ({ text } = report);
  }
  if (report.kind === "failed") {
    text = report.reason;
  }
  return teamTriggerIn(
    tx,
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
  (triggers: Pick<Triggers, "acceptIn">): TerminalNoticeIn =>
  async (tx, record, reason) => {
    await triggers.acceptIn(
      tx,
      await teamTriggerIn(
        tx,
        record,
        { kind: "teamnotice", key: record.admission.key, reason },
        reason === "expired"
          ? "The team work deadline expired."
          : "The team command could not be delivered."
      )
    );
  };
