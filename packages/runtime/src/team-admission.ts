import { InvalidInput, toContractFailure } from "@cerebro/contracts/failures";
import { normalizeTeamCommand } from "@cerebro/contracts/team-events";
import type { TeamCommandTransport } from "@cerebro/contracts/team-events";
import { digestToolArguments } from "@cerebro/contracts/tools";
import type { WorkAdmission } from "@cerebro/contracts/work";
import { defineTask } from "@earendil-works/pi-durable";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";

import type { TeamEvents } from "./team-events.ts";
import {
  TeamCommandReceipts,
  TeamState,
  requireTeamAdmission,
  requireTeamRunning,
} from "./team-state.ts";

export const createTeamAdmission = (options: {
  readonly pi: Harness;
  readonly work: WorkAdmission;
  readonly now: () => number;
  readonly deliver: (
    command: TeamCommandTransport,
    nativeId: ConversationId,
    signal?: AbortSignal
  ) => Promise<void>;
  readonly events?: TeamEvents;
}) => {
  const { pi, work, now } = options;
  return defineTask<
    TeamCommandTransport,
    | { phase: "submit"; attempt: number }
    | { phase: "retry"; attempt: number; until: number },
    { delivered: boolean }
  >({
    name: "cerebro.team-admission",
    version: 1,
    initial: () => ({ phase: "submit", attempt: 0 }),
    abort: (current, runtime, context) => {
      const { command, wire } = normalizeTeamCommand(current.input);
      return runtime.commit(async (tx) => {
        const document = await tx.doc(TeamState);
        Reflect.deleteProperty(document.pending, command.id);
        if (wire.kind === "event-command") {
          const receipt = await tx.doc(TeamCommandReceipts, command.id, null);
          if (
            receipt.receipt?.taskId !== runtime.taskId ||
            receipt.receipt.digest !== (await digestToolArguments(wire))
          ) {
            throw new InvalidInput({
              reason: "The saved event admission changed before abort.",
            });
          }
          await options.events?.returnIn(
            tx,
            wire,
            "The subscribed work stopped before processing this event."
          );
        }
        return {
          status: "terminal",
          outcome: { status: "aborted", reason: "cancelled" },
        };
      }, context);
    },
    phases: {
      retry: async (current, runtime, context) => {
        await runtime.sleep(current.state.checkpoint.until, context);
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              phase: "submit",
              attempt: current.state.checkpoint.attempt,
            },
          }),
          context
        );
      },
      submit: async (current, runtime, context) => {
        const { command, wire, event } = normalizeTeamCommand(current.input);
        const state = await pi.snapshot(TeamState, context);
        let delivered = false;
        try {
          if (!state || !state.lead) {
            throw new InvalidInput({ reason: "The team lead is missing." });
          }
          requireTeamAdmission(state, command.work);
          requireTeamRunning(state, now());
          const receipt = await pi.snapshot(
            TeamCommandReceipts,
            command.id,
            context
          );
          if (
            receipt?.receipt?.taskId !== runtime.taskId ||
            receipt.receipt.digest !== (await digestToolArguments(wire))
          ) {
            throw new InvalidInput({
              reason: "The saved team command changed.",
            });
          }
          await options.deliver(wire, state.lead, context.abortSignal);
          delivered = true;
        } catch (error) {
          if (context.abortSignal?.aborted) {
            throw error;
          }
          const failure = toContractFailure(
            error,
            "The team input is unavailable."
          );
          if (
            failure._tag !== "Denied" &&
            failure._tag !== "InvalidInput" &&
            failure._tag !== "NotFound"
          ) {
            const attempt = current.state.checkpoint.attempt + 1;
            const until = now() + 1000 * 2 ** (attempt - 1);
            if (attempt < 5 && until < work.deadlineAt) {
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
            const document = await tx.doc(TeamState);
            if (!event && document.phase === "running") {
              document.phase = "failed";
            }
            Reflect.deleteProperty(document.pending, command.id);
            if (wire.kind === "event-command") {
              await options.events?.returnIn(
                tx,
                wire,
                "The subscribed work could not process this event."
              );
            }
            return {
              status: "terminal",
              outcome: { status: "completed", result: { delivered: false } },
            };
          }, context);
          return;
        }
        await runtime.commit(async (tx) => {
          const document = await tx.doc(TeamState);
          Reflect.deleteProperty(document.pending, command.id);
          return {
            status: "terminal",
            outcome: { status: "completed", result: { delivered } },
          };
        }, context);
      },
    },
  });
};
