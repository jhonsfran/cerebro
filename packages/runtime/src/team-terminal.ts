import { InvalidInput } from "@cerebro/contracts/failures";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Cursor,
  Harness,
} from "@earendil-works/pi-durable";

import { piContext } from "./pi-harness.ts";
import { TeamState } from "./team-state.ts";

const roleTasks = async (pi: Harness, ids: readonly ConversationId[]) => {
  const statuses = ["pending", "running", "waiting", "completing"] as const;
  const pages = await Promise.all(
    ids.flatMap((conversationId) =>
      statuses.map(async (status) => {
        const items = [];
        let cursor: Cursor | undefined;
        do {
          const current = cursor;
          // oxlint-disable-next-line no-await-in-loop -- Each page supplies the next storage cursor.
          const page = await pi.commit(
            (tx) => tx.scanTasks({ conversationId, status }, 32, current),
            piContext()
          );
          items.push(...page.items);
          cursor = page.next;
        } while (cursor);
        return items;
      })
    )
  );
  return pages.flat();
};

export const drainTerminalTeam = async (pi: Harness): Promise<void> => {
  const state = await pi.snapshot(TeamState, piContext());
  if (
    !state ||
    (state.phase !== "cancelled" &&
      state.phase !== "failed" &&
      state.phase !== "completed" &&
      !state.report &&
      (state.admission?.deadlineAt ?? Infinity) > Date.now())
  ) {
    throw new InvalidInput({
      reason: "Only terminal Team work can be drained without its roles.",
    });
  }
  const ids = state.lead
    ? [state.lead, ...state.workers.map((worker) => worker.nativeId)]
    : [];
  const before = await pi.inspect(piContext());
  const paused = before.scheduling === "paused";
  await Promise.all(
    ids.map(async (nativeId) => {
      const inbox = await pi.snapshot(InboxDoc, nativeId, piContext());
      await Promise.all(
        (inbox?.items ?? []).map(async (item) => {
          const submission = await pi.submission(item.id, piContext());
          if (!submission) {
            throw new InvalidInput({
              reason: "A queued Team input is missing.",
            });
          }
          await submission.abort(piContext());
        })
      );
    })
  );
  const tasks = await roleTasks(pi, ids);
  await Promise.all(tasks.map((task) => pi.abortTask(task.id, piContext())));
  const marked = await roleTasks(pi, ids);
  const after = await pi.inspect(piContext());
  if (
    marked.some((task) => !task.abortRequested) ||
    (paused && after.scheduling !== "paused")
  ) {
    throw new InvalidInput({
      reason: "Terminal Team execution was not marked before scheduling.",
    });
  }
  await Promise.all(tasks.map((task) => pi.waitForTask(task.id, piContext())));
  const remaining = await roleTasks(pi, ids);
  const views = await Promise.all(
    ids.map(async (nativeId) => ({
      live: await pi.snapshot(LiveDoc, nativeId, piContext()),
      inbox: await pi.snapshot(InboxDoc, nativeId, piContext()),
    }))
  );
  if (
    remaining.length > 0 ||
    views.some(
      ({ live, inbox }) =>
        live?.run ||
        live?.generation ||
        Object.keys(live?.tools ?? {}).length > 0 ||
        (inbox?.items.length ?? 0) > 0
    )
  ) {
    throw new InvalidInput({
      reason: "Terminal Team execution did not drain.",
    });
  }
  await pi.commit(async (tx) => {
    const current = await tx.doc(TeamState);
    const pending = await Promise.all(
      Object.entries(current.pending).map(async ([id, taskId]) => ({
        id,
        task: await tx.task(taskId),
      }))
    );
    for (const item of pending) {
      if (item.task && item.task.state.status !== "terminal") {
        throw new InvalidInput({
          reason: "A terminal Team admission is still active.",
        });
      }
      Reflect.deleteProperty(current.pending, item.id);
    }
  }, piContext());
};
