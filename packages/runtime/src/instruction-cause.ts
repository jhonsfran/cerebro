import type { EventAddress } from "@cerebro/contracts/events";
import { Denied } from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import {
  REPLY_NUDGE_ENTRY_KIND,
  ReplyNudgeEntryDataSchema,
  TRIGGER_ENTRY_KIND,
  TriggerEntryDataSchema,
  replyNudgeRequestId,
  triggerActor,
} from "@cerebro/contracts/triggers";
import { LiveDoc } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  EntryRecord,
  Harness,
  SubmissionId,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import {
  coordinatorOperationKey,
  sameWorkSource,
} from "./coordinator-ledger.ts";
import { piContext } from "./pi-harness.ts";
import { Receipts } from "./trigger-receipts.ts";

export interface InstructionCandidate {
  readonly operationId: string;
  readonly key: string;
  readonly submissionId: SubmissionId;
}
export interface InstructionCause extends InstructionCandidate {
  readonly kind: "human" | "routine";
  readonly eventId: string;
}

/** The trigger an input entry stands for, and the request ID that input must carry. */
const causeOf = (
  entry: EntryRecord
): { readonly triggerId: string; readonly requestId: string } | undefined => {
  if (
    entry.kind === TRIGGER_ENTRY_KIND &&
    Schema.is(TriggerEntryDataSchema)(entry.data)
  ) {
    return { triggerId: entry.data.id, requestId: entry.data.id };
  }
  if (
    entry.kind === REPLY_NUDGE_ENTRY_KIND &&
    Schema.is(ReplyNudgeEntryDataSchema)(entry.data)
  ) {
    return {
      triggerId: entry.data.id,
      requestId: replyNudgeRequestId(entry.data.id),
    };
  }
};

export const currentInstructionCandidates = async (
  pi: Harness,
  nativeId: ConversationId
): Promise<InstructionCandidate[]> => {
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

export const requireInstructionCauseIn = async (
  tx: Tx,
  options: {
    readonly address: EventAddress;
    readonly ownerPrincipalId: PrincipalId;
    readonly nativeId: ConversationId;
    readonly candidates: readonly InstructionCandidate[];
  }
): Promise<InstructionCause> => {
  const live = await tx.doc(LiveDoc, options.nativeId);
  const inputs = new Set(live.run?.inputs);
  const verified = await Promise.all(
    options.candidates.map(
      async (candidate): Promise<InstructionCause | undefined> => {
        const submission = await tx.submissionByRequest(
          options.nativeId,
          candidate.operationId
        );
        if (
          !submission ||
          submission.type !== "input" ||
          submission.id !== candidate.submissionId ||
          !inputs.has(submission.id) ||
          (submission.status !== "placed" && submission.status !== "done")
        ) {
          return;
        }
        const entry = await tx.entry(submission.entry);
        const cause = entry && causeOf(entry);
        if (!cause || cause.requestId !== candidate.operationId) {
          return;
        }
        const saved = await tx.doc(Receipts, cause.triggerId, null);
        const trigger = saved.receipt?.trigger;
        if (
          !trigger ||
          saved.receipt?.nativeId !== options.nativeId ||
          trigger.id !== cause.triggerId ||
          trigger.ownerPrincipalId !== options.ownerPrincipalId ||
          !sameWorkSource(trigger.address, options.address)
        ) {
          return;
        }
        const actor = triggerActor(trigger.origin);
        return actor === "internal"
          ? undefined
          : { ...candidate, kind: actor, eventId: trigger.id };
      }
    )
  );
  const cause =
    verified.findLast((candidate) => candidate?.kind === "human") ??
    verified.findLast((candidate) => candidate?.kind === "routine");
  if (!cause) {
    throw new Denied({
      code: "unauthorized",
      reason:
        "A new instruction requires a current human request or authorized routine.",
    });
  }
  return cause;
};

export const prepareInstructionCause = async (options: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly address: EventAddress;
  readonly ownerPrincipalId: PrincipalId;
}): Promise<(tx: Tx) => Promise<InstructionCause>> => {
  const candidates = await currentInstructionCandidates(
    options.pi,
    options.nativeId
  );
  return (tx) => requireInstructionCauseIn(tx, { ...options, candidates });
};
