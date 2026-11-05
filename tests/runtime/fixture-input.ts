/* oxlint-disable no-await-in-loop -- Entry pages share one bounded scan budget. */
import type {
  ConversationId,
  Cursor,
  EntryRecord,
  Harness,
  StorageWrite,
  SubmissionRecord,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import type { PrincipalId } from "../../packages/contracts/src/identity.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import { webEventData } from "../../packages/runtime/src/coordinator-event-input.ts";
import {
  BotEventReceipts,
  eventOf,
} from "../../packages/runtime/src/coordinator-event-state.ts";
import type { BotEventReceipt } from "../../packages/runtime/src/coordinator-event-state.ts";
import { sameWorkSource } from "../../packages/runtime/src/coordinator-ledger.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";

export interface InputCorrelation {
  readonly address: EventAddress;
  readonly operationId: string;
  readonly eventId: string;
  readonly nativeRequestId: string;
  readonly submissionId: string;
  readonly entryId: string;
  readonly nativeSessionId: string;
}
interface Source {
  readonly address: EventAddress;
  readonly ownerPrincipalId: PrincipalId;
  readonly nativeSessionId: string;
}
const nativeId = Schema.declare<ConversationId>(
  (value): value is ConversationId =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
);
const conversationId = (value: string): ConversationId =>
  Schema.decodeUnknownSync(nativeId)(Number(value));

const placedInput = async (tx: Tx, source: Source, requestId: string) => {
  const submission = await tx.submissionByRequest(
    conversationId(source.nativeSessionId),
    requestId
  );
  if (submission?.type !== "input" || submission.entry === undefined) {
    throw new Error("The exact fixture input is not placed.");
  }
  const entry = await tx.entry(submission.entry);
  if (
    !entry ||
    String(entry.conversationId) !== source.nativeSessionId ||
    entry.conversationId !== submission.conversationId
  ) {
    throw new Error("The fixture input entry belongs to another conversation.");
  }
  return { entry, submission };
};
const admissionMatches = (
  receipt: BotEventReceipt,
  entry: EntryRecord,
  submission: SubmissionRecord
): boolean => {
  if (receipt.delivery.kind !== "coordinator") {
    return false;
  }
  const { admission } = receipt.delivery;
  return (
    "requestId" in admission &&
    admission.requestId === submission.requestId &&
    submission.entry === entry.id &&
    (!("submissionId" in admission) ||
      admission.submissionId === submission.id) &&
    (!("entry" in admission) || admission.entry === entry.id)
  );
};

const webInputIn = async (
  tx: Tx,
  source: Source,
  entry: EntryRecord,
  submission: SubmissionRecord
): Promise<InputCorrelation> => {
  const data =
    entry.kind === "cerebro.bot-event-input"
      ? webEventData(entry.data)
      : undefined;
  if (!data) {
    throw new Error("The fixture input is not a validated web event.");
  }
  const { receipt } = await tx.doc(BotEventReceipts, data.eventId, null);
  if (!receipt) {
    throw new Error("The fixture input has no saved event receipt.");
  }
  const event = eventOf(receipt);
  const message = entry.model?.[0];
  if (
    event.id !== data.eventId ||
    event.source.kind !== "web" ||
    event.source.operationId !== data.operationId ||
    event.ownerPrincipalId !== source.ownerPrincipalId ||
    !sameWorkSource(event.coordinator, source.address) ||
    String(receipt.nativeId) !== source.nativeSessionId ||
    receipt.digest !== (await digestToolArguments(receipt.input)) ||
    !admissionMatches(receipt, entry, submission) ||
    submission.requestId !== data.eventId ||
    message?.role !== "user" ||
    message.content !== event.content.text
  ) {
    throw new Error(
      "The fixture event, source, and native input do not agree."
    );
  }
  return {
    address: source.address,
    operationId: data.operationId,
    eventId: data.eventId,
    nativeRequestId: submission.requestId,
    submissionId: String(submission.id),
    entryId: String(entry.id),
    nativeSessionId: source.nativeSessionId,
  };
};

export const commitFailures = (
  storage: Pick<DurableObjectStorage, "sql">,
  sessionId: string
) =>
  storage.sql
    .exec<{
      operationId: string;
      instanceId: string;
      committedSeq: number;
      witness: string | null;
    }>(
      "SELECT f.operation_id AS operationId, f.instance_id AS instanceId, f.committed_seq AS committedSeq, w.body AS witness FROM fixture_commit_failure f LEFT JOIN fixture_commit_witness w ON w.session_id=f.session_id AND w.operation_id=f.operation_id WHERE f.session_id=? ORDER BY f.rowid",
      sessionId
    )
    .toArray()
    .map((row) => {
      const witness: unknown = row.witness ? JSON.parse(row.witness) : null;
      return { ...row, witness };
    });

export const readInputCorrelation = (
  pi: Harness,
  source: Source,
  operationId: string,
  text: string
): Promise<InputCorrelation> =>
  pi.commit(async (tx) => {
    let cursor: Cursor | undefined;
    const candidates: EntryRecord[] = [];
    let remaining = 2000;
    do {
      const page = await tx.scanEntries(
        { conversationId: conversationId(source.nativeSessionId) },
        Math.min(remaining, 100),
        cursor
      );
      candidates.push(
        ...page.items.filter(
          (entry) =>
            String(entry.conversationId) === source.nativeSessionId &&
            entry.kind === "cerebro.bot-event-input" &&
            webEventData(entry.data)?.operationId === operationId
        )
      );
      remaining -= page.items.length;
      cursor = page.next;
      if (cursor && remaining <= 0) {
        throw new Error("The fixture input scan exceeded its entry budget.");
      }
    } while (cursor);
    const [entry] = candidates;
    const data = entry && webEventData(entry.data);
    if (candidates.length !== 1 || !entry || !data) {
      throw new Error("Exactly one saved fixture web input is required.");
    }
    const placed = await placedInput(tx, source, data.eventId);
    if (placed.entry.id !== entry.id || entry.model?.[0]?.content !== text) {
      throw new Error("The fixture input does not match the original text.");
    }
    return await webInputIn(tx, source, entry, placed.submission);
  }, piContext());

export const physicalInput = (
  pi: Harness,
  source: Source,
  requestId: string | undefined,
  instanceId: string
) =>
  pi.commit(async (tx) => {
    const common = {
      address: source.address,
      nativeSessionId: source.nativeSessionId,
      instanceId,
    };
    if (requestId === undefined) {
      return { kind: "maintenance" as const, ...common };
    }
    const { entry, submission } = await placedInput(tx, source, requestId);
    if (entry.kind === "cerebro.bot-event-input" && webEventData(entry.data)) {
      return {
        kind: "web" as const,
        ...(await webInputIn(tx, source, entry, submission)),
        instanceId,
      };
    }
    return {
      kind: "native" as const,
      ...common,
      nativeRequestId: requestId,
      submissionId: String(submission.id),
      entryId: String(entry.id),
    };
  }, piContext());

export const matchCommittedInput = (
  writes: readonly StorageWrite[],
  nativeSessionId: string,
  operationId: string,
  kind: "submission" | "compaction"
) => {
  for (const write of writes) {
    if (
      kind === "compaction" &&
      write.type === "task" &&
      write.value.kind === "pi.compaction" &&
      String(write.value.conversationId) === nativeSessionId
    ) {
      return { kind: "compaction" as const, taskId: String(write.value.id) };
    }
    if (
      kind !== "submission" ||
      write.type !== "submission" ||
      write.value.type !== "input" ||
      write.value.status !== "placed" ||
      String(write.value.conversationId) !== nativeSessionId
    ) {
      continue;
    }
    const submission = write.value;
    if (!submission.requestId) {
      continue;
    }
    const entry = writes.find(
      (candidate) =>
        candidate.type === "entry" &&
        candidate.value.id === submission.entry &&
        candidate.value.conversationId === submission.conversationId
    );
    if (entry?.type !== "entry") {
      continue;
    }
    const data =
      entry.value.kind === "cerebro.bot-event-input"
        ? webEventData(entry.value.data)
        : undefined;
    if (
      (data?.operationId === operationId &&
        data.eventId === submission.requestId) ||
      (entry.value.kind === "pi.user" && submission.requestId === operationId)
    ) {
      return {
        kind: "submission" as const,
        nativeRequestId: submission.requestId,
        submissionId: String(submission.id),
        entryId: String(submission.entry),
      };
    }
  }
};
