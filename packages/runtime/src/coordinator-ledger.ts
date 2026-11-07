import type { EventAddress } from "@cerebro/contracts/events";
import { Conflict, Denied, NotFound } from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { TeamCommandTransport } from "@cerebro/contracts/team-events";
import {
  WorkCommandIdSchema,
  WorkAdmissionSchema,
  transitionWorkStatus,
} from "@cerebro/contracts/work";
import type {
  WorkAdmission,
  WorkReport,
  WorkStatus,
} from "@cerebro/contracts/work";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { JsonObject, TaskId, Tx } from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { discardQueuedCommandsIn } from "./coordinator-retired-events.ts";

export interface CoordinationBinding {
  readonly address: EventAddress;
  readonly ownerPrincipalId: PrincipalId;
}
export interface CoordinatorCommandReceipt extends JsonObject {
  taskId: TaskId;
  digest: string;
}
export interface CoordinatorWorkRecord extends JsonObject {
  admission: WorkAdmission;
  humanOperationId: string | null;
  status: WorkStatus;
  reportId: string | null;
  pendingCommands: Record<string, CoordinatorCommandReceipt>;
  dispatched: boolean;
  queuedCommands: Record<string, TeamCommandTransport>;
  terminalReport: WorkReport | null;
}
export const retainedWorkDependencies = (
  records: readonly CoordinatorWorkRecord[]
): ContentDependencies => ({
  sourceIds: [
    ...new Set(
      records.flatMap((record) => [
        ...record.admission.contentDependencies.sourceIds,
        ...(record.terminalReport?.contentDependencies.sourceIds ?? []),
      ])
    ),
  ],
  toolIds: [
    ...new Set(
      records.flatMap((record) => [
        ...record.admission.contentDependencies.toolIds,
        ...(record.terminalReport?.contentDependencies.toolIds ?? []),
      ])
    ),
  ],
});
export interface WorkLedgerState extends JsonObject {
  identity: { organizationId: string; ownerPrincipalId: string } | null;
  active: Record<
    string,
    { source: WorkAdmission["sourceEventAddress"]; deadlineAt: number }
  >;
  queue: {
    workId: string;
    source: WorkAdmission["sourceEventAddress"];
    deadlineAt: number;
  }[];
}
export const RecentTerminalWork = defineDocFamily({
  kind: "cerebro.recent-terminal-work",
  scope: "session",
  family: true,
  version: 1,
  initial: (_seed: null): { ids: string[] } => ({ ids: [] }),
});
export const retainTerminalWorkIn = async (
  tx: Tx,
  record: CoordinatorWorkRecord
): Promise<void> => {
  if (
    record.status.kind === "queued" ||
    record.status.kind === "accepted" ||
    record.status.kind === "running"
  ) {
    return;
  }
  const recent = await tx.doc(
    RecentTerminalWork,
    record.admission.sourceEventAddress.sessionId,
    null
  );
  recent.ids = [
    record.admission.key.workId,
    ...recent.ids.filter((id) => id !== record.admission.key.workId),
  ].slice(0, 16);
};
export const WorkLedger = defineDoc({
  kind: "cerebro.coordinator-index",
  scope: "session",
  version: 3,
  migrate: (): WorkLedgerState => {
    throw new Error("Unsupported coordinator index version.");
  },
  initial: (): WorkLedgerState => ({ identity: null, active: {}, queue: [] }),
});
export const WorkDocuments = defineDocFamily({
  kind: "cerebro.coordinator-work",
  scope: "session",
  family: true,
  version: 4,
  migrate: (): { record: CoordinatorWorkRecord | null } => {
    throw new Error("Unsupported coordinator work version.");
  },
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
export const SourceWork = defineDoc({
  kind: "cerebro.coordinator-source-work",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  version: 1,
  initial: (): { workId: string | null } => ({ workId: null }),
});
export const SourceOperations = defineDocFamily({
  kind: "cerebro.coordinator-source-operation",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  version: 1,
  initial: (
    operationId: string
  ): {
    operationId: string;
    route: SourceRoute | null;
    digest: string | null;
  } => ({
    operationId,
    route: null,
    digest: null,
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
  const admission = Schema.decodeUnknownSync(WorkAdmissionSchema, {
    onExcessProperty: "error",
  })(record.admission);
  if (
    admission.key.organizationId !== binding.address.organizationId ||
    admission.key.ownerPrincipalId !== binding.ownerPrincipalId ||
    !sameWorkSource(admission.sourceEventAddress, binding.address)
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "This work belongs to another conversation.",
    });
  }
};
export const workHoldsSlot = (
  record: CoordinatorWorkRecord,
  now: number
): boolean =>
  record.dispatched &&
  record.reportId === null &&
  record.admission.deadlineAt > now;
export const workAcceptsEvents = (
  record: CoordinatorWorkRecord,
  now: number
): boolean =>
  record.reportId === null &&
  record.admission.deadlineAt > now &&
  (record.status.kind === "queued" ||
    (record.dispatched &&
      (record.status.kind === "accepted" || record.status.kind === "running")));
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
export const pruneWorkIndex = async (
  tx: Tx,
  ledger: WorkLedgerState,
  now: number
): Promise<CoordinatorWorkRecord[]> => {
  const expired: CoordinatorWorkRecord[] = [];
  await Promise.all(
    Object.entries(ledger.active)
      .filter(([, entry]) => entry.deadlineAt <= now)
      .map(async ([workId]) => {
        const document = await tx.doc(WorkDocuments, workId, null);
        if (document.record) {
          if (
            document.record.status.kind === "accepted" ||
            document.record.status.kind === "running"
          ) {
            expired.push(document.record);
          }
          document.record.status = transitionWorkStatus(
            document.record.status,
            { kind: "failed", reason: "The team work deadline expired." }
          );
          await retainTerminalWorkIn(tx, document.record);
        }
        Reflect.deleteProperty(ledger.active, workId);
      })
  );
  const { queue } = ledger;
  await Promise.all(
    queue
      .filter((entry) => entry.deadlineAt <= now)
      .map(async ({ workId }) => {
        const document = await tx.doc(WorkDocuments, workId, null);
        if (document.record) {
          if (document.record.status.kind === "queued") {
            expired.push(document.record);
          }
          document.record.status = transitionWorkStatus(
            document.record.status,
            {
              kind: "failed",
              reason: "The team work deadline expired.",
            }
          );
          await retainTerminalWorkIn(tx, document.record);
          await discardQueuedCommandsIn(tx, document.record, "expired");
        }
      })
  );
  ledger.queue = queue.filter((entry) => entry.deadlineAt > now);
  return expired;
};
export const applyCoordinatorReport = async (
  tx: Tx,
  binding: CoordinationBinding,
  report: WorkReport,
  admit: (tx: Tx, report: WorkReport) => Promise<void>,
  now = Date.now(),
  expired?: (tx: Tx, record: CoordinatorWorkRecord) => Promise<void>
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
    const notify =
      record.status.kind === "queued" ||
      record.status.kind === "accepted" ||
      record.status.kind === "running";
    record.status = transitionWorkStatus(record.status, {
      kind: "failed",
      reason: "The team work deadline expired.",
    });
    if (notify) {
      await expired?.(tx, record);
    }
  }
  const ledger = await tx.doc(WorkLedger);
  if (record.status.kind === "cancelled" || record.status.kind === "failed") {
    record.reportId = report.id;
    await retainTerminalWorkIn(tx, record);
    Reflect.deleteProperty(ledger.active, report.key.workId);
    return { accepted: false, status: { ...record.status } };
  }
  await admit(tx, report);
  record.terminalReport = report;
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
  await retainTerminalWorkIn(tx, record);
  return { accepted: true, status: { ...record.status } };
};
