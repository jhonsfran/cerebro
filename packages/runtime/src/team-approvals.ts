import {
  Conflict,
  Denied,
  InvalidInput,
  Unavailable,
} from "@cerebro/contracts/failures";
import type {
  ChatApproval,
  ChatDecisionReceipt,
} from "@cerebro/contracts/session-service";
import { TeamApprovalRequestSchema } from "@cerebro/contracts/team-events";
import type {
  TeamApprovalDecision,
  TeamApprovalRequest,
} from "@cerebro/contracts/team-events";
import {
  canonicalToolArguments,
  digestToolArguments,
} from "@cerebro/contracts/tools";
import { workCellName } from "@cerebro/contracts/work";
import type { WorkAdmission } from "@cerebro/contracts/work";
import {
  defineDoc,
  defineDocFamily,
  defineTask,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  Registry,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { createApprovalStore } from "./approval-store.ts";
import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import { TeamState, teamInputRejection } from "./team-state.ts";

export interface TeamApprovalTransport {
  readonly check: (request: TeamApprovalRequest) => void;
  readonly send: (request: TeamApprovalRequest) => Promise<void>;
}
export const TeamApprovalRequests = defineDocFamily({
  kind: "cerebro.team-approval-request",
  scope: "session",
  family: true,
  version: 1,
  initial: (
    _seed: null
  ): {
    record: { digest: string; taskId: TaskId; until: number } | null;
  } => ({ record: null }),
});
export const TeamApprovalOutbox = defineDoc({
  kind: "cerebro.team-approval-outbox",
  scope: "session",
  version: 1,
  initial: (): { pending: Record<string, TaskId> } => ({ pending: {} }),
});
const MAX_PENDING_REQUESTS = 8;
const finishIn = async (tx: Tx, approvalId: string) => {
  const outbox = await tx.doc(TeamApprovalOutbox);
  Reflect.deleteProperty(outbox.pending, approvalId);
};

// Every role of one Team shares this store, so one decision wakes whichever role waits.
export const teamApprovalStore = (
  storage: DurableObjectStorage,
  work: WorkAdmission
) => createApprovalStore(storage, workCellName(work.key));

export const createTeamApprovalRequests = (options: {
  readonly pi: Harness;
  readonly registry: Registry;
  readonly nativeId: ConversationId;
  readonly work: WorkAdmission;
  readonly transport: TeamApprovalTransport;
  readonly persist: () => Promise<void>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly now?: () => number;
}) => {
  const now = options.now ?? Date.now;
  const decode = Schema.decodeUnknownSync(TeamApprovalRequestSchema, {
    onExcessProperty: "error",
  });
  const task = defineTask<
    TeamApprovalRequest,
    | { phase: "send"; attempt: number }
    | { phase: "retry"; attempt: number; until: number },
    { sent: boolean }
  >({
    name: "cerebro.team-approval-request",
    version: 1,
    initial: () => ({ phase: "send", attempt: 0 }),
    abort: (current, runtime, context) =>
      runtime.commit(async (tx) => {
        await finishIn(tx, current.input.approval.approvalId);
        return {
          status: "terminal",
          outcome: { status: "aborted", reason: "cancelled" },
        };
      }, context),
    phases: {
      retry: async (current, runtime, context) => {
        await runtime.sleep(current.state.checkpoint.until, context);
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              phase: "send",
              attempt: current.state.checkpoint.attempt,
            },
          }),
          context
        );
      },
      send: async (current, runtime, context) => {
        const request = decode(current.input);
        const { approvalId } = request.approval;
        const document = await options.pi.snapshot(
          TeamApprovalRequests,
          approvalId,
          context
        );
        const record = document?.record;
        if (
          record?.taskId !== runtime.taskId ||
          record.digest !== (await digestToolArguments(request))
        ) {
          throw new InvalidInput({
            reason: "The saved approval request changed.",
          });
        }
        let sent = false;
        try {
          if (now() < record.until) {
            await options.persist();
            await options.transport.send(request);
            sent = true;
          }
        } catch (error) {
          if (context.abortSignal?.aborted) {
            throw error;
          }
          const attempt = current.state.checkpoint.attempt + 1;
          const until = now() + 1000 * 2 ** (attempt - 1);
          if (attempt < 5 && until < record.until) {
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: { phase: "retry", attempt, until },
              }),
              context
            );
            return;
          }
        }
        await runtime.commit(async (tx) => {
          await finishIn(tx, approvalId);
          return {
            status: "terminal",
            outcome: { status: "completed", result: { sent } },
          };
        }, context);
      },
    },
  });
  options.registry.install({
    name: "cerebro.team-approval-requests",
    tasks: [task],
  });
  const hold = async () => {
    const outbox = await options.pi.snapshot(TeamApprovalOutbox, piContext());
    const tasks = Object.values(outbox?.pending ?? {});
    trackNativeProgress(options.pi, { tasks }, options.waitUntil);
    return tasks.length > 0;
  };
  return {
    // A replayed tool call reaches this again; the saved request keeps it to one send.
    requestIn: async (tx: Tx, approval: ChatApproval): Promise<void> => {
      if (approval.state !== "pending") {
        return;
      }
      const document = await tx.doc(
        TeamApprovalRequests,
        approval.approvalId,
        null
      );
      if (document.record) {
        return;
      }
      const request = decode({
        version: 2,
        kind: "approval-request",
        work: options.work,
        approval: { ...approval, workId: options.work.key.workId },
      });
      options.transport.check(request);
      const outbox = await tx.doc(TeamApprovalOutbox);
      if (Object.keys(outbox.pending).length >= MAX_PENDING_REQUESTS) {
        throw new Unavailable({
          reason: "This Team has eight undelivered approval requests.",
          retryAfter: 5,
        });
      }
      const taskId = await tx.createTask(task, request, {
        background: true,
        conversationId: options.nativeId,
        ownership: { kind: "conversation" },
      });
      document.record = {
        digest: await digestToolArguments(request),
        taskId,
        until: now() + 60_000,
      };
      outbox.pending[approval.approvalId] = taskId;
    },
    hold,
    wake: async () =>
      (await hold()) ? { rescheduleAt: now() + 5000 } : undefined,
  };
};
export type TeamApprovalRequestOutbox = ReturnType<
  typeof createTeamApprovalRequests
>;

/**
 * Applies a person's decision relayed from the coordinator. The returned state is the
 * Team's truth: a Team that stopped cancels its pending approval instead of allowing it.
 */
export const decideTeamApproval = async (input: {
  readonly pi: Harness;
  readonly approvals: ReturnType<typeof createApprovalStore>;
  readonly decision: TeamApprovalDecision;
  readonly persist: () => Promise<void>;
  readonly now?: () => number;
}): Promise<ChatDecisionReceipt> => {
  const { approvals, decision } = input;
  const now = input.now ?? Date.now;
  const approval = await input.pi.commit(async (tx) => {
    const state = await tx.doc(TeamState);
    if (
      !state.admission ||
      canonicalToolArguments(state.admission) !==
        canonicalToolArguments(decision.work)
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "The decision addresses another Team admission.",
      });
    }
    if (teamInputRejection(state, decision.work, now())) {
      approvals.cancel(decision.approvalId);
    } else {
      try {
        approvals.decide(decision.approvalId, decision.decision);
      } catch (error) {
        if (!(error instanceof Conflict)) {
          throw error;
        }
      }
    }
    return approvals.read(decision.approvalId);
  }, piContext());
  await input.persist();
  return { approvalId: approval.approvalId, state: approval.state };
};
