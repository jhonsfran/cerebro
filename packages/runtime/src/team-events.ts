import {
  Conflict,
  Denied,
  InvalidInput,
  Unavailable,
} from "@cerebro/contracts/failures";
import type { ContentDependencies } from "@cerebro/contracts/session";
import {
  TeamEventCommandSchema,
  TeamEventReturnSchema,
} from "@cerebro/contracts/team-events";
import type {
  TeamEventCommand,
  TeamEventReturn,
} from "@cerebro/contracts/team-events";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { TeamCommandReceiptSchema } from "@cerebro/contracts/work";
import type { WorkAdmission } from "@cerebro/contracts/work";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineDocFamily,
  defineTask,
  defineTool,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  JsonObject,
  Registry,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { coordinationToolResult } from "./coordination-tool-result.ts";
import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import {
  TeamCommandReceipts,
  TeamState,
  requireTeamAdmission,
  requireTeamRunning,
} from "./team-state.ts";

export interface TeamEventReturnTransport {
  readonly authorize: (dependencies: ContentDependencies) => Promise<void>;
  readonly send: (delivery: TeamEventReturn) => Promise<void>;
}
interface TeamEventRecord extends JsonObject {
  command: TeamEventCommand;
  digest: string;
  state:
    | { kind: "admitted" }
    | { kind: "blocked"; reason: string }
    | {
        kind: "returned";
        delivery: TeamEventReturn;
        reason: string;
        digest: string;
        taskId: TaskId;
        until: number;
      };
}
export const TeamEventReceipts = defineDocFamily({
  kind: "cerebro.team-event",
  scope: "session",
  family: true,
  version: 1,
  initial: (_seed: null): { record: TeamEventRecord | null } => ({
    record: null,
  }),
});
export const TeamEventReturns = defineDoc({
  kind: "cerebro.team-event-returns",
  scope: "session",
  version: 1,
  initial: (): { pending: Record<string, TaskId> } => ({ pending: {} }),
});

export const createTeamEvents = (options: {
  readonly pi: Harness;
  readonly registry: Registry;
  readonly nativeId: ConversationId;
  readonly work: WorkAdmission;
  readonly transport: TeamEventReturnTransport;
  readonly persist: () => Promise<void>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly now?: () => number;
}) => {
  const now = options.now ?? Date.now;
  const returnReason = Schema.NonEmptyString.check(Schema.isMaxLength(1000));
  const saveIn = async (
    tx: Tx,
    input: TeamEventCommand
  ): Promise<TeamEventRecord> => {
    const command = Schema.decodeUnknownSync(TeamEventCommandSchema, {
      onExcessProperty: "error",
    })(input);
    const state = await tx.doc(TeamState);
    requireTeamAdmission(state, command.command.work);
    if (
      (await digestToolArguments(options.work)) !==
      (await digestToolArguments(command.command.work))
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "The event addresses another team admission.",
      });
    }
    const digest = await digestToolArguments(command);
    const document = await tx.doc(TeamEventReceipts, command.event.id, null);
    if (document.record) {
      if (document.record.digest !== digest) {
        throw new Conflict({
          code: "digest-mismatch",
          reason: "The event ID names another Team input.",
        });
      }
      return document.record;
    }
    document.record = { command, digest, state: { kind: "admitted" } };
    return document.record;
  };
  const task = defineTask<
    { eventId: string },
    | { phase: "send"; attempt: number }
    | { phase: "retry"; attempt: number; until: number },
    { sent: boolean }
  >({
    name: "cerebro.team-event-return",
    version: 1,
    initial: () => ({ phase: "send", attempt: 0 }),
    abort: (current, runtime, context) =>
      runtime.commit(async (tx) => {
        const pending = await tx.doc(TeamEventReturns);
        Reflect.deleteProperty(pending.pending, current.input.eventId);
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
        const document = await options.pi.snapshot(
          TeamEventReceipts,
          current.input.eventId,
          context
        );
        const record = document?.record;
        if (
          !record ||
          record.state.kind !== "returned" ||
          record.state.taskId !== runtime.taskId ||
          record.state.digest !==
            (await digestToolArguments(record.state.delivery)) ||
          record.digest !== (await digestToolArguments(record.command))
        ) {
          throw new InvalidInput({ reason: "The saved event return changed." });
        }
        let sent = false;
        try {
          if (now() < record.state.until) {
            await options.transport.authorize(
              record.command.command.contentDependencies
            );
            await options.persist();
            await options.transport.send(record.state.delivery);
            sent = true;
          }
        } catch (error) {
          if (context.abortSignal?.aborted) {
            throw error;
          }
          const attempt = current.state.checkpoint.attempt + 1;
          const until = now() + 1000 * 2 ** (attempt - 1);
          if (
            !(error instanceof Denied) &&
            attempt < 5 &&
            until < record.state.until
          ) {
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
          const pending = await tx.doc(TeamEventReturns);
          Reflect.deleteProperty(pending.pending, current.input.eventId);
          return {
            status: "terminal",
            outcome: { status: "completed", result: { sent } },
          };
        }, context);
      },
    },
  });
  options.registry.install({
    name: "cerebro.team-event-returns",
    tasks: [task],
  });
  const returnIn = async (
    tx: Tx,
    command: TeamEventCommand,
    reason: string,
    strict = false
  ) => {
    const privateReason = Schema.decodeUnknownSync(returnReason)(reason);
    const document = await tx.doc(TeamEventReceipts, command.event.id, null);
    const { record } = document;
    if (!record || record.digest !== (await digestToolArguments(command))) {
      throw new InvalidInput({
        reason: "The Team did not admit this exact event command.",
      });
    }
    const delivery = Schema.decodeUnknownSync(TeamEventReturnSchema)({
      version: 2,
      kind: "event-return",
      work: options.work,
      eventId: command.event.id,
      eventDigest: command.event.digest,
    });
    const digest = await digestToolArguments(delivery);
    if (record.state.kind === "returned") {
      if (
        strict &&
        (record.state.digest !== digest ||
          record.state.reason !== privateReason)
      ) {
        throw new Conflict({
          code: "digest-mismatch",
          reason: "The saved event return reason changed.",
        });
      }
      return;
    }
    if (record.state.kind === "blocked") {
      return;
    }
    const pending = await tx.doc(TeamEventReturns);
    if (Object.keys(pending.pending).length >= 8) {
      throw new Unavailable({
        reason: "This Team has eight pending event returns.",
        retryAfter: 5,
      });
    }
    const taskId = await tx.createTask(
      task,
      { eventId: command.event.id },
      {
        background: true,
        conversationId: options.nativeId,
        ownership: { kind: "conversation" },
      }
    );
    record.state = {
      kind: "returned",
      delivery,
      reason: privateReason,
      digest,
      taskId,
      until: now() + 60_000,
    };
    pending.pending[command.event.id] = taskId;
  };
  const hold = async () => {
    const pending = await options.pi.snapshot(TeamEventReturns, piContext());
    const tasks = Object.values(pending?.pending ?? {});
    trackNativeProgress(options.pi, { tasks }, options.waitUntil);
    return tasks.length > 0;
  };
  const fallback = async (
    command: TeamEventCommand,
    reason: "cancelled" | "terminal" | "expired" | "revoked"
  ) => {
    let denied = reason === "revoked";
    try {
      await options.transport.authorize(command.command.contentDependencies);
    } catch (error) {
      if (!(error instanceof Denied)) {
        throw error;
      }
      denied = true;
    }
    const digest = await digestToolArguments(command);
    const result = await options.pi.commit(async (tx) => {
      const state = await tx.doc(TeamState);
      requireTeamAdmission(state, options.work);
      const receipt = await tx.doc(
        TeamCommandReceipts,
        command.command.id,
        null
      );
      if (receipt.receipt) {
        if (receipt.receipt.digest !== digest) {
          throw new Conflict({
            code: "digest-mismatch",
            reason: "The Team command changed.",
          });
        }
        if (denied) {
          throw new Denied({
            code: "revoked",
            reason: "Current access no longer permits this event handoff.",
          });
        }
        return {
          digest: receipt.receipt.digest,
          taskId: receipt.receipt.taskId,
          accepted: receipt.receipt.accepted,
          reason: receipt.receipt.reason,
        };
      }
      const record = await saveIn(tx, command);
      if (denied) {
        record.state = {
          kind: "blocked",
          reason: "Current access does not permit this event handoff.",
        };
      } else {
        await returnIn(
          tx,
          command,
          "The subscribed work no longer accepts this event."
        );
      }
      const saved = { digest, taskId: null, accepted: false, reason };
      receipt.receipt = saved;
      return saved;
    }, piContext());
    await options.persist();
    return Schema.decodeUnknownSync(TeamCommandReceiptSchema)({
      commandId: command.command.id,
      key: options.work.key,
      kind: result.accepted ? "accepted" : "rejected",
      ...(result.reason ? { reason: result.reason } : {}),
    });
  };
  const tool = (
    permit: (
      dependencies: ContentDependencies,
      signal?: AbortSignal
    ) => Promise<void>
  ) =>
    defineTool({
      name: "return_event",
      callers: ["model"],
      replay: "safe",
      description:
        "Return a saved external event that is unrelated to this Team's work to the coordinator. This does not cancel or finish the Team.",
      parameters: Type.Object({
        eventId: Type.String({ minLength: 1, maxLength: 512 }),
        reason: Type.String({ minLength: 1, maxLength: 1000 }),
      }),
      execute: ({ eventId, reason }, api, context) =>
        coordinationToolResult(async () => {
          const state = await options.pi.snapshot(TeamState, context);
          if (!state || state.lead !== api.conversationId) {
            throw new Denied({
              code: "unauthorized",
              reason: "Only the Team lead can return an event.",
            });
          }
          requireTeamRunning(state, now());
          const document = await options.pi.snapshot(
            TeamEventReceipts,
            eventId,
            context
          );
          if (!document?.record) {
            throw new InvalidInput({
              reason: "The Team did not receive this event.",
            });
          }
          const { command } = document.record;
          await permit(
            command.command.contentDependencies,
            context.abortSignal
          );
          await api.commit(async (tx) => {
            const current = await tx.doc(TeamState);
            requireTeamRunning(current, now());
            if (current.lead !== api.conversationId) {
              throw new Denied({
                code: "unauthorized",
                reason: "Only the Team lead can return an event.",
              });
            }
            await returnIn(tx, command, reason, true);
          }, context);
          await options.persist();
          await hold();
          return { eventId, returned: true };
        }),
    });
  return {
    saveIn,
    returnIn,
    fallback,
    tool,
    hold,
    wake: async () =>
      (await hold()) ? { rescheduleAt: now() + 5000 } : undefined,
  };
};
export type TeamEvents = ReturnType<typeof createTeamEvents>;
