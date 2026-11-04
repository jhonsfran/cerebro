import {
  BoundedContentDependenciesSchema,
  WorkReportSchema,
} from "@cerebro/contracts/work";
import type { WorkAdmission, WorkReport } from "@cerebro/contracts/work";
import { AssistantEntry } from "@earendil-works/pi-durable";
import type { Harness, Tx } from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { piContext } from "./pi-harness.ts";
import type { TeamRole } from "./team-role.ts";
import { TeamState } from "./team-state.ts";
import type { TeamStateValue } from "./team-state.ts";

export const createTeamCompletion = (options: {
  readonly pi: Harness;
  readonly work: WorkAdmission;
  readonly roles: readonly Pick<TeamRole, "dependencies">[];
  readonly now: () => number;
  readonly abort: () => Promise<void>;
  readonly holdAdmissions: () => Promise<void>;
  readonly persistReportIn?: (tx: Tx, report: WorkReport) => Promise<void>;
  readonly emitReport?: (report: WorkReport) => Promise<void>;
}) => {
  const { pi, work, now } = options;
  const snapshot = () => pi.snapshot(TeamState, piContext());
  const heartbeat = () => ({
    rescheduleAt: Math.min(work.deadlineAt, now() + 5000),
  });
  const saveReport = async (text = "", requestCount?: number) => {
    const dependencies = [
      work.contentDependencies,
      ...(await Promise.all(options.roles.map((role) => role.dependencies()))),
    ];
    const combined = {
      sourceIds: [...new Set(dependencies.flatMap((value) => value.sourceIds))],
      toolIds: [...new Set(dependencies.flatMap((value) => value.toolIds))],
    };
    const bounded = Schema.is(BoundedContentDependenciesSchema)(combined);
    await pi.commit(async (tx) => {
      const state = await tx.doc(TeamState);
      if (state.report) {
        return;
      }
      if (
        requestCount !== undefined &&
        (Object.keys(state.pending).length > 0 ||
          state.requests.length !== requestCount)
      ) {
        return;
      }
      if (state.phase === "running") {
        state.phase =
          bounded &&
          text.trim() &&
          text.length <= 16_000 &&
          work.deadlineAt > now()
            ? "completed"
            : "failed";
      }
      const result =
        bounded && state.phase === "completed"
          ? { kind: "completed", text }
          : {
              kind: "failed",
              reason:
                "The team could not complete within its execution limits.",
            };
      state.report = Schema.decodeUnknownSync(WorkReportSchema)({
        id: `report:${work.key.workId}`,
        key: work.key,
        contentDependencies: bounded
          ? combined
          : { sourceIds: [], toolIds: [] },
        ...(state.phase === "cancelled" ? { kind: "cancelled" } : result),
      });
      await options.persistReportIn?.(tx, state.report);
    }, piContext());
  };
  const finishRunning = async (state: TeamStateValue) => {
    const nativeId = state.lead;
    if (!nativeId) {
      return;
    }
    const submissions = await pi.commit(
      (tx) =>
        Promise.all(
          state.requests.map((requestId) =>
            tx.submissionByRequest(nativeId, requestId)
          )
        ),
      piContext()
    );
    if (
      submissions.some(
        (value) =>
          !value || value.status === "queued" || value.status === "placed"
      )
    ) {
      return;
    }
    const latest = submissions.at(-1);
    const entry =
      latest?.status === "done" && latest.type === "input"
        ? await pi.commit(
            (tx) => tx.entry(AssistantEntry, latest.answer),
            piContext()
          )
        : undefined;
    const message = entry?.model?.[0];
    const text =
      message?.role === "assistant"
        ? message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        : "";
    await saveReport(text, state.requests.length);
  };
  const reconcile = () =>
    pi.commit(async (tx) => {
      const state = await tx.doc(TeamState);
      await Promise.all(
        Object.entries(state.pending).map(async ([id, taskId]) => {
          const task = await tx.task(taskId);
          if (!task || task.state.status === "terminal") {
            Reflect.deleteProperty(state.pending, id);
          }
        })
      );
    }, piContext());
  return async (deadlineAt: number) => {
    let state = await snapshot();
    if (!state?.admission) {
      return deadlineAt > now()
        ? { rescheduleAt: Math.min(deadlineAt, now() + 5000) }
        : undefined;
    }
    if (state.phase === "running" && work.deadlineAt <= now()) {
      await pi.commit(async (tx) => {
        const document = await tx.doc(TeamState);
        if (document.phase === "running") {
          document.phase = "failed";
        }
      }, piContext());
      await options.abort();
    }
    pi.resume();
    await options.holdAdmissions();
    await reconcile();
    state = await snapshot();
    if (!state) {
      return;
    }
    if (state.phase === "failed" || state.phase === "cancelled") {
      await options.abort();
      await saveReport();
    } else if (state.phase === "running") {
      if (Object.keys(state.pending).length > 0) {
        return heartbeat();
      }
      await finishRunning(state);
    }
    const final = await snapshot();
    if (!final) {
      return;
    }
    if (final.phase === "failed" || final.phase === "cancelled") {
      await options.abort();
    }
    if (final.phase === "running" && !final.report) {
      return heartbeat();
    }
    if (final.report && options.emitReport) {
      await options.emitReport(final.report);
    }
  };
};
