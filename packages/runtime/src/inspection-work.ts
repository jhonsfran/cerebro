import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, NotFound } from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import type {
  InspectionWork,
  InspectionResult,
  InspectionQuery,
} from "@cerebro/contracts/inspection";
import type { WorkReport } from "@cerebro/contracts/work";
import type { Harness, ConversationId } from "@earendil-works/pi-durable";

import type { ScanWorkKeys } from "./coordinator-history.ts";
import {
  WorkDocuments,
  RecentTerminalWork,
  SourceWork,
  WorkLedger,
  requireWorkSource,
  sameWorkSource,
  workHoldsSlot,
} from "./coordinator-ledger.ts";
import type { CoordinatorWorkRecord } from "./coordinator-ledger.ts";
import {
  ThreadSubscriptions,
  WorkSubscriptions,
} from "./coordinator-subscriptions.ts";
import {
  inspectionText,
  inspectionCursor,
  nextInspectionCursor,
} from "./inspection-page.ts";
import { piContext } from "./pi-harness.ts";

export const inspectionResult = (
  report: WorkReport | null
): InspectionResult | null => {
  if (!report) {
    return null;
  }
  let text = "Work failed.";
  if (report.kind === "completed") {
    ({ text } = report);
  }
  if (report.kind === "cancelled") {
    text = "Work cancelled.";
  }
  return { id: report.id, kind: report.kind, content: inspectionText(text) };
};
export const readOwnedWork = async (input: {
  readonly pi: Harness;
  readonly address: EventAddress;
  readonly ownerPrincipalId: PrincipalId;
  readonly workId: string;
  readonly signal?: AbortSignal;
}): Promise<CoordinatorWorkRecord> => {
  const document = await input.pi.snapshot(
    WorkDocuments,
    input.workId,
    piContext(input.signal)
  );
  if (!document?.record) {
    throw new NotFound({ resource: "Team work" });
  }
  requireWorkSource(document.record, input);
  if (document.record.admission.key.workId !== input.workId) {
    throw new Denied({
      code: "unauthorized",
      reason: "The retained work ID changed.",
    });
  }
  return document.record;
};
export const projectInspectionWork = async (
  pi: Harness,
  record: CoordinatorWorkRecord,
  signal?: AbortSignal
): Promise<InspectionWork> => {
  const { admission } = record;
  const saved = await pi.snapshot(
    WorkSubscriptions,
    admission.key.workId,
    piContext(signal)
  );
  const subscriptions: InspectionWork["subscriptions"][number][] = [];
  if (saved?.record) {
    if (
      saved.record.binding.ownerPrincipalId !==
        admission.key.ownerPrincipalId ||
      !sameWorkSource(
        saved.record.binding.address,
        admission.sourceEventAddress
      )
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "The work subscriptions belong to another source.",
      });
    }
    const threads = await Promise.all(
      saved.record.threadKeys
        .slice(0, 8)
        .map((key) => pi.snapshot(ThreadSubscriptions, key, piContext(signal)))
    );
    for (const thread of threads) {
      if (
        thread?.record &&
        thread.record.binding.ownerPrincipalId ===
          admission.key.ownerPrincipalId &&
        sameWorkSource(
          thread.record.binding.address,
          admission.sourceEventAddress
        ) &&
        thread.record.workIds.includes(admission.key.workId)
      ) {
        subscriptions.push({
          workspaceId: thread.record.thread.workspaceId,
          channelId: thread.record.thread.channelId,
          rootTimestamp: thread.record.thread.rootTimestamp,
        });
      }
    }
  }
  return {
    workId: admission.key.workId,
    goal: inspectionText(admission.goal),
    status: record.status.kind,
    admittedAt: admission.admittedAt,
    deadlineAt: admission.deadlineAt,
    dispatched: record.dispatched,
    reservationHeld: workHoldsSlot(record, Date.now()),
    result: inspectionResult(record.terminalReport),
    subscriptions,
  };
};

export const readInspectionWorkPage = async (input: {
  readonly pi: Harness;
  readonly address: EventAddress;
  readonly nativeId: ConversationId;
  readonly ownerPrincipalId: PrincipalId;
  readonly query: Extract<InspectionQuery, { kind: "overview" | "history" }>;
  readonly scanWorkKeys: ScanWorkKeys;
  readonly signal?: AbortSignal;
}) => {
  const { pi, address, query, ownerPrincipalId, signal } = input;
  const owned = (workId: string) =>
    readOwnedWork({ pi, address, ownerPrincipalId, workId, signal });
  if (query.kind === "history") {
    const page = await input.scanWorkKeys(inspectionCursor(address, query));
    const candidates = await Promise.all(
      page.keys.map(async (workId) => {
        try {
          return await owned(workId);
        } catch (error) {
          if (error instanceof Denied || error instanceof NotFound) {
            return null;
          }
          throw error;
        }
      })
    );
    return {
      records: candidates.filter((record) => record !== null),
      next: nextInspectionCursor(address, query, page.next),
    };
  }
  const ledger = await pi.snapshot(WorkLedger, piContext(signal));
  if (
    ledger?.identity &&
    (ledger.identity.ownerPrincipalId !== ownerPrincipalId ||
      ledger.identity.organizationId !== address.organizationId)
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The work ledger belongs to another owner.",
    });
  }
  const [recent, current] = await Promise.all([
    pi.snapshot(RecentTerminalWork, address.sessionId, piContext(signal)),
    pi.snapshot(SourceWork, input.nativeId, piContext(signal)),
  ]);
  const ids = [
    ...Object.entries(ledger?.active ?? {})
      .filter(([, value]) => sameWorkSource(value.source, address))
      .map(([id]) => id),
    ...(ledger?.queue ?? [])
      .filter((value) => sameWorkSource(value.source, address))
      .map((value) => value.workId),
    ...(recent?.ids ?? []),
    ...(current?.workId ? [current.workId] : []),
  ];
  return {
    records: await Promise.all([...new Set(ids)].slice(0, 48).map(owned)),
    next: null,
  };
};
