import type { EventAddress } from "@cerebro/contracts/events";
import { Conflict, Denied, NotFound } from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import {
  WorkCommandIdSchema,
  transitionWorkStatus,
} from "@cerebro/contracts/work";
import type {
  SlackThread,
  WorkAdmission,
  WorkReport,
  WorkStatus,
} from "@cerebro/contracts/work";
import {
  LiveDoc,
  defineDoc,
  defineDocFamily,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  JsonObject,
  SubmissionId,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { piContext } from "./pi-harness.ts";

export interface CoordinationBinding {
  readonly address: EventAddress;
  readonly ownerPrincipalId: PrincipalId;
  readonly thread: SlackThread;
}
export interface CoordinatorCommandReceipt extends JsonObject {
  taskId: TaskId;
  digest: string;
}
export interface CoordinatorWorkRecord extends JsonObject {
  admission: WorkAdmission;
  status: WorkStatus;
  reportId: string | null;
  pendingCommands: Record<string, CoordinatorCommandReceipt>;
}
interface WorkLedgerState extends JsonObject {
  identity: { organizationId: string; ownerPrincipalId: string } | null;
  active: Record<
    string,
    { source: WorkAdmission["sourceEventAddress"]; deadlineAt: number }
  >;
}
export const WorkLedger = defineDoc({
  kind: "cerebro.coordinator-index",
  scope: "session",
  version: 1,
  initial: (): WorkLedgerState => ({ identity: null, active: {} }),
});
export const WorkDocuments = defineDocFamily({
  kind: "cerebro.coordinator-work",
  scope: "session",
  family: true,
  version: 1,
  initial: (_seed: null): { record: CoordinatorWorkRecord | null } => ({
    record: null,
  }),
});
export const CommandReceipts = defineDocFamily({
  kind: "cerebro.coordinator-command",
  scope: "session",
  family: true,
  version: 1,
  initial: (_seed: null): { receipt: CoordinatorCommandReceipt | null } => ({
    receipt: null,
  }),
});
type SourceRoute =
  | { kind: "coordinator"; workId: string | null }
  | { kind: "team"; workId: string; commandId: string };
export const SourceOperations = defineDocFamily({
  kind: "cerebro.coordinator-source-operation",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  version: 1,
  initial: (
    operationId: string
  ): { operationId: string; route: SourceRoute | null } => ({
    operationId,
    route: null,
  }),
});
export const CoordinatorAdmissions = defineDoc({
  kind: "cerebro.coordinator-admissions",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  version: 1,
  initial: (): { leases: Record<string, number> } => ({ leases: {} }),
});
export const coordinatorOperationKey = async (
  value: string
): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};
export const sameWorkSource = (
  left: EventAddress,
  right: EventAddress
): boolean =>
  left.organizationId === right.organizationId &&
  left.agentId === right.agentId &&
  left.conversationId === right.conversationId &&
  left.sessionId === right.sessionId;
export const requireWorkIdentity = (
  ledger: WorkLedgerState,
  binding: CoordinationBinding
): void => {
  if (!ledger.identity) {
    ledger.identity = {
      organizationId: binding.address.organizationId,
      ownerPrincipalId: binding.ownerPrincipalId,
    };
  }
  if (
    ledger.identity.organizationId !== binding.address.organizationId ||
    ledger.identity.ownerPrincipalId !== binding.ownerPrincipalId
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The work ledger belongs to another identity.",
    });
  }
};
export const requireWorkSource = (
  record: CoordinatorWorkRecord,
  binding: CoordinationBinding
): void => {
  const { admission } = record;
  if (
    admission.key.organizationId !== binding.address.organizationId ||
    admission.key.ownerPrincipalId !== binding.ownerPrincipalId ||
    !sameWorkSource(admission.sourceEventAddress, binding.address) ||
    admission.sourceSlackThread.channelId !== binding.thread.channelId ||
    admission.sourceSlackThread.workspaceId !== binding.thread.workspaceId ||
    admission.sourceSlackThread.rootTimestamp !== binding.thread.rootTimestamp
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "This work belongs to another Slack source.",
    });
  }
};
export const workHoldsSlot = (
  record: CoordinatorWorkRecord,
  now: number
): boolean => record.reportId === null && record.admission.deadlineAt > now;
export const requireCoordinatorWork = async (
  tx: Tx,
  binding: CoordinationBinding,
  workId: string
) => {
  const ledger = await tx.doc(WorkLedger);
  requireWorkIdentity(ledger, binding);
  const document = await tx.doc(WorkDocuments, workId, null);
  if (!document.record) {
    throw new NotFound({ resource: "Team work" });
  }
  requireWorkSource(document.record, binding);
  return document.record;
};
interface HumanCandidate {
  readonly operationId: string;
  readonly key: string;
  readonly submissionId: SubmissionId;
}
export const currentHumanCandidates = async (
  pi: Harness,
  nativeId: ConversationId
): Promise<HumanCandidate[]> => {
  const live = await pi.snapshot(LiveDoc, nativeId, piContext());
  const candidates = await Promise.all(
    (live?.run?.inputs ?? []).map(async (submissionId) => {
      const submission = await pi.submission(submissionId, piContext());
      const record = await submission?.status(piContext());
      if (record?.type !== "input" || !record.requestId) {
        return;
      }
      return {
        submissionId,
        operationId: record.requestId,
        key: await coordinatorOperationKey(record.requestId),
      };
    })
  );
  return candidates.filter((candidate) => candidate !== undefined);
};
export const currentHumanOperation = async (
  tx: Tx,
  binding: CoordinationBinding,
  nativeId: ConversationId,
  candidates: readonly HumanCandidate[]
) => {
  const ledger = await tx.doc(WorkLedger);
  requireWorkIdentity(ledger, binding);
  const live = await tx.doc(LiveDoc, nativeId);
  const inputs = new Set(live.run?.inputs);
  const verified = await Promise.all(
    candidates.map(async (candidate) => {
      const submission = await tx.submissionByRequest(
        nativeId,
        candidate.operationId
      );
      if (
        !submission ||
        submission.type !== "input" ||
        submission.id !== candidate.submissionId ||
        !inputs.has(submission.id)
      ) {
        return;
      }
      const operation = await tx.doc(
        SourceOperations,
        nativeId,
        candidate.key,
        candidate.operationId
      );
      return operation.operationId === candidate.operationId &&
        operation.route?.kind === "coordinator"
        ? candidate
        : undefined;
    })
  );
  const current = verified.findLast((candidate) => candidate !== undefined);
  if (!current) {
    throw new Denied({
      code: "unauthorized",
      reason: "A new team requires a current human request.",
    });
  }
  return current;
};
export const pruneWorkIndex = async (
  tx: Tx,
  ledger: WorkLedgerState,
  now: number
): Promise<void> => {
  await Promise.all(
    Object.entries(ledger.active)
      .filter(([, entry]) => entry.deadlineAt <= now)
      .map(async ([workId]) => {
        const document = await tx.doc(WorkDocuments, workId, null);
        if (document.record) {
          document.record.status = transitionWorkStatus(
            document.record.status,
            { kind: "failed", reason: "The team work deadline expired." }
          );
        }
        Reflect.deleteProperty(ledger.active, workId);
      })
  );
};
export const applyCoordinatorReport = async (
  tx: Tx,
  binding: CoordinationBinding,
  report: WorkReport,
  admit: (tx: Tx, report: WorkReport) => Promise<void>,
  now = Date.now()
): Promise<{ readonly accepted: boolean; readonly status: WorkStatus }> => {
  const record = await requireCoordinatorWork(tx, binding, report.key.workId);
  if (
    report.key.organizationId !== record.admission.key.organizationId ||
    report.key.ownerPrincipalId !== record.admission.key.ownerPrincipalId
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The report belongs to another work identity.",
    });
  }
  if (record.reportId !== null) {
    if (record.reportId !== report.id) {
      throw new Conflict({
        code: "digest-mismatch",
        reason: "The work already has another terminal report.",
      });
    }
    return { accepted: false, status: { ...record.status } };
  }
  if (record.admission.deadlineAt <= now) {
    record.status = transitionWorkStatus(record.status, {
      kind: "failed",
      reason: "The team work deadline expired.",
    });
  }
  const ledger = await tx.doc(WorkLedger);
  if (record.status.kind === "cancelled" || record.status.kind === "failed") {
    record.reportId = report.id;
    Reflect.deleteProperty(ledger.active, report.key.workId);
    return { accepted: false, status: { ...record.status } };
  }
  await admit(tx, report);
  record.reportId = report.id;
  Reflect.deleteProperty(ledger.active, report.key.workId);
  if (report.kind === "completed") {
    record.status = transitionWorkStatus(record.status, {
      kind: "completed",
      reportId: report.id,
    });
  } else if (report.kind === "failed") {
    record.status = transitionWorkStatus(record.status, {
      kind: "failed",
      reason: report.reason,
    });
  } else {
    record.status = transitionWorkStatus(record.status, {
      commandId: Schema.decodeUnknownSync(WorkCommandIdSchema)(
        `cancel:${report.key.workId}`
      ),
      kind: "cancelled",
    });
  }
  return { accepted: true, status: { ...record.status } };
};
