import { InvalidInput } from "@cerebro/contracts/failures";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { TeamReportDeliverySchema } from "@cerebro/contracts/work";
import type { TeamReportDelivery, WorkReport } from "@cerebro/contracts/work";
import { defineDoc, defineTask } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  Registry,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";

export interface TeamReportTransport {
  readonly prepare: (report: WorkReport) => TeamReportDelivery;
  readonly send: (delivery: TeamReportDelivery) => Promise<void>;
}
export const TeamReportOutbox = defineDoc({
  kind: "cerebro.team-report-outbox",
  scope: "session",
  version: 1,
  initial: (): {
    taskId: TaskId | null;
    digest: string | null;
    until: number;
  } => ({ taskId: null, digest: null, until: 0 }),
});
export const createTeamReportOutbox = (options: {
  readonly pi: Harness;
  readonly registry: Registry;
  readonly nativeId: ConversationId;
  readonly transport: TeamReportTransport;
  readonly persist: () => Promise<void>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}) => {
  const task = defineTask<
    TeamReportDelivery,
    | { phase: "send"; attempt: number }
    | { phase: "retry"; attempt: number; until: number },
    { sent: boolean }
  >({
    name: "cerebro.team-report",
    version: 1,
    initial: () => ({ phase: "send", attempt: 0 }),
    abort: (_task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "cancelled" },
        }),
        context
      ),
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
        const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema, {
          onExcessProperty: "error",
        })(current.input);
        const outbox = await options.pi.snapshot(TeamReportOutbox, context);
        if (
          outbox?.taskId !== runtime.taskId ||
          outbox.digest !== (await digestToolArguments(delivery))
        ) {
          throw new InvalidInput({ reason: "The saved team report changed." });
        }
        let sent = false;
        try {
          if (Date.now() < outbox.until) {
            await options.persist();
            await options.transport.send(delivery);
            sent = true;
          }
        } catch (error) {
          if (context.abortSignal?.aborted) {
            throw error;
          }
          const attempt = current.state.checkpoint.attempt + 1;
          const until = Date.now() + 1000 * 2 ** (attempt - 1);
          if (attempt < 5 && until < outbox.until) {
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
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: { sent } },
          }),
          context
        );
      },
    },
  });
  options.registry.install({ name: "cerebro-team-report", tasks: [task] });
  const hold = async () => {
    const outbox = await options.pi.snapshot(TeamReportOutbox, piContext());
    if (outbox?.taskId !== null && outbox?.taskId !== undefined) {
      trackNativeProgress(
        options.pi,
        { tasks: [outbox.taskId] },
        options.waitUntil
      );
    }
  };
  return {
    enqueueIn: async (tx: Tx, report: WorkReport): Promise<void> => {
      const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema, {
        onExcessProperty: "error",
      })(options.transport.prepare(report));
      const digest = await digestToolArguments(delivery);
      const outbox = await tx.doc(TeamReportOutbox);
      if (outbox.taskId !== null) {
        if (outbox.digest !== digest) {
          throw new InvalidInput({
            reason: "The terminal team report changed.",
          });
        }
        return;
      }
      outbox.digest = digest;
      outbox.until = Date.now() + 60_000;
      outbox.taskId = await tx.createTask(task, delivery, {
        background: true,
        conversationId: options.nativeId,
        ownership: { kind: "conversation" },
      });
    },
    wake: async () => {
      options.pi.resume();
      await hold();
      const outbox = await options.pi.snapshot(TeamReportOutbox, piContext());
      if (outbox?.taskId === null || outbox?.taskId === undefined) {
        return;
      }
      const { taskId } = outbox;
      const pending = await options.pi.commit(
        (tx) => tx.task(taskId),
        piContext()
      );
      return pending?.state.status !== "terminal" && outbox.until > Date.now()
        ? { rescheduleAt: Math.min(outbox.until, Date.now() + 5000) }
        : undefined;
    },
    hold,
  };
};
