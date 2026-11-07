import {
  Conflict,
  Denied,
  NotFound,
  Unavailable,
} from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import { ChatApproval } from "@cerebro/contracts/session-service";
import type { ChatDecisionReceipt } from "@cerebro/contracts/session-service";
import {
  TeamApprovalReceiptSchema,
  TeamApprovalRequestSchema,
} from "@cerebro/contracts/team-events";
import type { TeamApprovalReceipt } from "@cerebro/contracts/team-events";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { Schema } from "effect";

import type { createConversationResources } from "./conversation-resources.ts";
import { teamTriggerIn } from "./coordinator-event-content.ts";
import {
  TeamApprovalIndex,
  TeamApprovals,
  WorkDocuments,
  coordinatorOperationKey,
  requireCoordinatorWork,
  requireWorkSource,
  sameWorkSource,
} from "./coordinator-ledger.ts";
import type {
  CoordinatorWorkRecord,
  TeamApprovalMirror,
} from "./coordinator-ledger.ts";
import type { createCoordinatorWork } from "./coordinator-work.ts";
import { piContext } from "./pi-harness.ts";
import type { Triggers } from "./triggers.ts";

// Settled entries leave the index first, so pending requests are never dropped.
const MAX_INDEXED_APPROVALS = 64;

const acceptsApprovals = (record: CoordinatorWorkRecord, now: number) =>
  record.reportId === null &&
  record.admission.deadlineAt > now &&
  (record.status.kind === "accepted" || record.status.kind === "running");
const currentState = (
  mirror: TeamApprovalMirror,
  approval: ChatApproval,
  now: number
): ChatApproval["state"] =>
  mirror.state === "pending" && approval.expiresAt <= now
    ? "expired"
    : mirror.state;
const publicApproval = (
  mirror: TeamApprovalMirror,
  now: number
): ChatApproval => {
  const approval = Schema.decodeUnknownSync(ChatApproval)(
    JSON.parse(mirror.approval)
  );
  return { ...approval, state: currentState(mirror, approval, now) };
};

/**
 * Team approval requests mirrored into the coordinator conversation. The mirror never
 * enters the conversation's own approval store, so it cannot hold the publication gate.
 */
export const createCoordinatorApprovals = (options: {
  readonly pi: Harness;
  readonly native: Conversation;
  readonly runtime: Pick<
    ReturnType<typeof createConversationResources>,
    "authorize" | "guardIn" | "configuration"
  >;
  readonly coordination: Pick<
    ReturnType<typeof createCoordinatorWork>,
    "binding" | "admissions"
  >;
  readonly triggers: Pick<Triggers, "acceptIn" | "drain">;
  readonly persist: () => Promise<void>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly now?: () => number;
}) => {
  const now = options.now ?? Date.now;
  const receive = async (
    input: unknown,
    context: ExecutionContext,
    signal?: AbortSignal
  ): Promise<TeamApprovalReceipt> => {
    const { work, approval } = Schema.decodeUnknownSync(
      TeamApprovalRequestSchema,
      { onExcessProperty: "error" }
    )(input);
    const binding = options.coordination.binding();
    if (!sameWorkSource(work.sourceEventAddress, binding.address)) {
      throw new Denied({
        code: "unauthorized",
        reason: "The approval request belongs to another source.",
      });
    }
    await options.runtime.authorize(context, "coordinate", signal);
    const canonical = canonicalToolArguments(approval);
    const accepted = await options.coordination.admissions.commit(
      `approval:${await coordinatorOperationKey(approval.approvalId)}`,
      async (tx) => {
        await options.runtime.guardIn(tx);
        const record = await requireCoordinatorWork(
          tx,
          binding,
          work.key.workId
        );
        if (
          canonicalToolArguments(record.admission) !==
          canonicalToolArguments(work)
        ) {
          throw new Denied({
            code: "unauthorized",
            reason: "The approval request names another work admission.",
          });
        }
        const document = await tx.doc(TeamApprovals, approval.approvalId, null);
        if (document.record) {
          if (document.record.approval !== canonical) {
            throw new Conflict({
              code: "digest-mismatch",
              reason: "The approval ID names another request.",
            });
          }
          return true;
        }
        if (!acceptsApprovals(record, now())) {
          return false;
        }
        const index = await tx.doc(
          TeamApprovalIndex,
          binding.address.sessionId,
          null
        );
        const indexed = await Promise.all(
          Object.keys(index.approvals).map(async (approvalId) => {
            const saved = await tx.doc(TeamApprovals, approvalId, null);
            return {
              approvalId,
              settled:
                !saved.record ||
                publicApproval(saved.record, now()).state !== "pending",
            };
          })
        );
        const overflow = indexed.length + 1 - MAX_INDEXED_APPROVALS;
        const removable = indexed.filter((entry) => entry.settled);
        if (overflow > removable.length) {
          throw new Unavailable({
            reason: "This conversation has too many pending Team approvals.",
            retryAfter: 30,
          });
        }
        for (const entry of removable.slice(0, Math.max(0, overflow))) {
          Reflect.deleteProperty(index.approvals, entry.approvalId);
        }
        document.record = {
          key: work.key,
          approval: canonical,
          state: "pending",
        };
        index.approvals[approval.approvalId] = work.key.workId;
        await options.triggers.acceptIn(
          tx,
          await teamTriggerIn(
            tx,
            record,
            {
              kind: "teamapproval",
              key: work.key,
              approvalId: approval.approvalId,
            },
            `Team work ${work.key.workId} asks to run the tool ${approval.toolId} and waits for approval. Tell the person to Allow or Deny it in web chat. You cannot decide it.`
          )
        );
        return true;
      }
    );
    if (accepted) {
      options.waitUntil(options.triggers.drain(options.native.id));
    }
    await options.persist();
    return Schema.decodeUnknownSync(TeamApprovalReceiptSchema)({
      approvalId: approval.approvalId,
      key: work.key,
      accepted,
    });
  };
  const list = async (signal?: AbortSignal): Promise<ChatApproval[]> => {
    const index = await options.pi.snapshot(
      TeamApprovalIndex,
      options.runtime.configuration.address.sessionId,
      piContext(signal)
    );
    const saved = await Promise.all(
      Object.keys(index?.approvals ?? {}).map((approvalId) =>
        options.pi.snapshot(TeamApprovals, approvalId, piContext(signal))
      )
    );
    return saved.flatMap((document) =>
      document?.record ? [publicApproval(document.record, now())] : []
    );
  };
  // The Team's answer is the truth, so a tool that already stopped reconciles here.
  const decide = async (
    approvalId: string,
    decision: "allow" | "deny",
    signal?: AbortSignal
  ): Promise<ChatDecisionReceipt> => {
    const services = options.runtime.configuration.coordination;
    const saved = await options.pi.snapshot(
      TeamApprovals,
      approvalId,
      piContext(signal)
    );
    if (!services || !saved?.record) {
      throw new NotFound({ resource: "Tool approval" });
    }
    const work = await options.pi.snapshot(
      WorkDocuments,
      saved.record.key.workId,
      piContext(signal)
    );
    if (!work?.record) {
      throw new NotFound({ resource: "Team work" });
    }
    requireWorkSource(work.record, options.coordination.binding());
    const receipt = await services.decideApproval(
      work.record.admission,
      approvalId,
      decision
    );
    if (receipt.approvalId !== approvalId) {
      throw new Unavailable({ reason: "The Team answered another approval." });
    }
    await options.pi.commit(async (tx) => {
      await options.runtime.guardIn(tx);
      const document = await tx.doc(TeamApprovals, approvalId, null);
      if (document.record) {
        document.record.state = receipt.state;
      }
    }, piContext(signal));
    await options.persist();
    return receipt;
  };
  return { receive, list, decide };
};
export type CoordinatorApprovals = ReturnType<
  typeof createCoordinatorApprovals
>;
