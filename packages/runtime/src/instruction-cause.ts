import type { EventAddress } from "@cerebro/contracts/events";
import { Denied } from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { LiveDoc } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  SubmissionId,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { BotEventReceipts, eventOf } from "./coordinator-event-state.ts";
import type { BotEventReceipt } from "./coordinator-event-state.ts";
import {
  SourceOperations,
  coordinatorOperationKey,
  sameWorkSource,
} from "./coordinator-ledger.ts";
import { piContext } from "./pi-harness.ts";

export interface InstructionCandidate {
  readonly operationId: string;
  readonly key: string;
  readonly submissionId: SubmissionId;
}
export interface InstructionCause extends InstructionCandidate {
  readonly kind: "human" | "routine";
  readonly eventId: string | null;
}
interface InstructionTarget {
  readonly address: EventAddress;
  readonly ownerPrincipalId: PrincipalId;
  readonly nativeId: ConversationId;
}
const eventData = Schema.Struct({
  eventId: Schema.NonEmptyString,
  source: Schema.String,
  agentVersion: Schema.Int,
  policyVersion: Schema.optional(Schema.Literals([0, 1])),
});
interface EventCauseTarget extends InstructionTarget {
  readonly candidate: InstructionCandidate;
  readonly data: typeof eventData.Type;
}
const eventMatchesCause = (
  receipt: BotEventReceipt,
  options: EventCauseTarget
): boolean => {
  const event = eventOf(receipt);
  return (
    receipt.nativeId === options.nativeId &&
    event.id === options.candidate.operationId &&
    options.data.eventId === event.id &&
    options.data.source === event.source.kind &&
    event.ownerPrincipalId === options.ownerPrincipalId &&
    sameWorkSource(event.coordinator, options.address)
  );
};
const eventInstructionCauseIn = async (
  tx: Tx,
  options: EventCauseTarget
): Promise<InstructionCause | undefined> => {
  const { candidate, data } = options;
  const saved = await tx.doc(BotEventReceipts, candidate.operationId, null);
  const { receipt } = saved;
  if (!receipt || receipt.delivery.kind !== "coordinator") {
    return;
  }
  const claim = receipt.delivery.admission;
  if (
    !eventMatchesCause(receipt, options) ||
    receipt.digest !== (await digestToolArguments(receipt.input)) ||
    claim.kind === "held" ||
    (claim.kind === "settled" && claim.outcome === "blocked")
  ) {
    return;
  }
  if (
    claim.requestId !== candidate.operationId ||
    claim.agentVersion !== data.agentVersion ||
    (claim.policyVersion ?? 0) !== (data.policyVersion ?? 0) ||
    (claim.kind !== "claimed" && claim.submissionId !== candidate.submissionId)
  ) {
    return;
  }
  const event = eventOf(receipt);
  switch (event.source.kind) {
    case "web":
    case "slack": {
      return { ...candidate, kind: "human", eventId: event.id };
    }
    case "savedtimer": {
      return { ...candidate, kind: "routine", eventId: event.id };
    }
    case "teamreport":
    case "coordinator-terminalnotice": {
      return;
    }
    default: {
      const exhaustive: never = event.source;
      return exhaustive;
    }
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
    readonly allowLegacyUser?: boolean;
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
        if (entry?.kind === "pi.user") {
          const operation = await tx.doc(
            SourceOperations,
            options.nativeId,
            candidate.key,
            candidate.operationId
          );
          return operation.operationId === candidate.operationId &&
            (operation.route?.kind === "coordinator" ||
              (options.allowLegacyUser === true && operation.route === null))
            ? { ...candidate, kind: "human", eventId: null }
            : undefined;
        }
        if (
          entry?.kind !== "cerebro.bot-event-input" ||
          !Schema.is(eventData)(entry.data)
        ) {
          return;
        }
        return await eventInstructionCauseIn(tx, {
          ...options,
          candidate,
          data: entry.data,
        });
      }
    )
  );
  const cause = verified.findLast((candidate) => candidate !== undefined);
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
  readonly allowLegacyUser?: boolean;
}): Promise<(tx: Tx) => Promise<InstructionCause>> => {
  const candidates = await currentInstructionCandidates(
    options.pi,
    options.nativeId
  );
  return (tx) => requireInstructionCauseIn(tx, { ...options, candidates });
};
