/* oxlint-disable no-await-in-loop -- Each rendered observation and timer cycle must settle before the next. */
import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  inspectionAddress,
  inspectionOverview,
  inspectionSnapshot,
  inspectionTasks,
  inspectionTeam,
  inspectionTranscript,
  inspectionWork,
} from "./inspection-ui-data.ts";
import {
  act,
  cleanupInspectionDom,
  inspectorFixture,
  installInspectionDom,
  waitFor,
} from "./inspection-ui-fixture.ts";

const inspectionClock = () => {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const setDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "setTimeout"
  );
  const clearDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "clearTimeout"
  );
  const pending = new Map<
    unknown,
    { timer: ReturnType<typeof setTimeout>; run: () => void }
  >();
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: (run: () => void, milliseconds?: number) => {
      if (milliseconds !== 2000) {
        return originalSet(run, milliseconds);
      }
      const timer = originalSet(() => {}, 3_600_000);
      timer.unref();
      pending.set(timer, { timer, run });
      assert.ok(
        pending.size <= 1,
        "The open Inspector must own at most one refresh timer."
      );
      return timer;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value: (timer: Parameters<typeof clearTimeout>[0]) => {
      pending.delete(timer);
      originalClear(timer);
    },
  });
  return {
    pending,
    next: async () => {
      assert.equal(
        pending.size,
        1,
        "Expected one completion-scheduled refresh."
      );
      const entry = pending.values().next();
      assert.equal(entry.done, false);
      if (entry.done) {
        assert.fail("Missing refresh timer.");
      }
      const { timer, run } = entry.value;
      pending.delete(timer);
      originalClear(timer);
      await act(() => run());
    },
    restore: () => {
      for (const { timer } of pending.values()) {
        originalClear(timer);
      }
      pending.clear();
      assert.ok(setDescriptor && clearDescriptor);
      Object.defineProperty(globalThis, "setTimeout", setDescriptor);
      Object.defineProperty(globalThis, "clearTimeout", clearDescriptor);
    },
  };
};
let clock: ReturnType<typeof inspectionClock>;
beforeEach(() => {
  installInspectionDom();
  clock = inspectionClock();
});
afterEach(() => {
  cleanupInspectionDom();
  clock.restore();
});

test("idle Inspector has no timer and streaming tokens do not trigger reads", async () => {
  const initial = inspectionSnapshot({
    messages: [
      {
        id: "answer-a",
        role: "assistant",
        state: "complete",
        outcome: "answered",
        text: "Initial answer",
      },
    ],
  });
  const fixture = inspectorFixture({ snapshot: initial });
  const view = fixture.mount();
  await waitFor(() => assert.ok(view.getByText("Select work to inspect")));
  assert.equal(fixture.calls.length, 1);
  assert.equal(clock.pending.size, 0);
  for (const text of [
    "A",
    "A useful",
    "A useful answer",
    "A useful answer is ready.",
  ]) {
    await act(() =>
      fixture.send({
        ...initial,
        busy: true,
        messages: [
          ...initial.messages,
          { id: "answer-b", role: "assistant", state: "streaming", text },
        ],
      })
    );
  }
  assert.equal(fixture.calls.length, 1);
  const completed = inspectionSnapshot({
    messages: [
      ...initial.messages,
      {
        id: "answer-b",
        role: "assistant",
        state: "complete",
        outcome: "answered",
        text: "A useful answer is ready.",
      },
    ],
  });
  await act(() => fixture.send(completed));
  await waitFor(() => assert.equal(fixture.calls.length, 2));
  await act(() =>
    fixture.send({
      ...completed,
      messages: [
        ...completed.messages,
        {
          id: "tool-call",
          role: "assistant",
          state: "complete",
          outcome: "tool-call",
          text: "",
        },
      ],
    })
  );
  assert.equal(fixture.calls.length, 2);
  await act(() =>
    fixture.send({
      ...completed,
      activity: {
        children: [],
        compactions: [],
        reminders: [],
        tasks: [],
        backgroundWork: {
          workId: inspectionWork().workId,
          status: { kind: "accepted" },
          deadlineAt: 1_800_000_060_000,
          canCancel: true,
        },
      },
    })
  );
  await waitFor(() => assert.equal(fixture.calls.length, 3));
  assert.equal(clock.pending.size, 0);
});

test("active overview retains one bounded retry after a transient failure with no Team selected", async () => {
  const work = inspectionWork("active", {
    status: "failed",
    reservationHeld: true,
  });
  let attempt = 0;
  const fixture = inspectorFixture({
    respond: () => {
      attempt += 1;
      if (attempt === 2) {
        return Response.json(
          { message: "Private backend detail" },
          { status: 503 }
        );
      }
      return Response.json(inspectionOverview([work], attempt < 3));
    },
  });
  const view = fixture.mount();
  await waitFor(() => assert.equal(clock.pending.size, 1));
  assert.ok(view.getByText("Slot reserved"));
  await clock.next();
  await waitFor(() =>
    assert.ok(view.getByText("Inspector is unavailable. Refresh to retry."))
  );
  assert.equal(view.queryByText("Private backend detail"), null);
  assert.equal(clock.pending.size, 1);
  await clock.next();
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Inspect work active" }))
  );
  assert.equal(fixture.calls.length, 3);
  assert.equal(clock.pending.size, 0);
});

test("refresh is scheduled only after the current read completes and closing cancels it", async () => {
  const held = Promise.withResolvers<Response>();
  const work = inspectionWork("queued", {
    status: "queued",
    dispatched: false,
  });
  const fixture = inspectorFixture({
    respond: async (_call, index) =>
      index === 1
        ? await held.promise
        : Response.json(inspectionOverview([work], true)),
  });
  const view = fixture.mount();
  await waitFor(() => assert.equal(fixture.calls.length, 1));
  assert.equal(clock.pending.size, 0);
  await act(async () => {
    held.resolve(Response.json(inspectionOverview([work], true)));
    await delay(0);
  });
  await waitFor(() => assert.equal(clock.pending.size, 1));
  await clock.next();
  await waitFor(() => assert.equal(fixture.calls.length, 2));
  await waitFor(() => assert.equal(clock.pending.size, 1));
  await act(() =>
    view.getByRole("button", { name: "Inspector", exact: true }).click()
  );
  assert.equal(clock.pending.size, 0);
  assert.ok(fixture.calls.every(({ signal }) => signal?.aborted));
});

test("selected sealed details stop polling while other work keeps overview refresh active", async () => {
  const work = inspectionWork();
  const queued = inspectionWork("queued", {
    status: "queued",
    dispatched: false,
  });
  const fixture = inspectorFixture({
    respond: ({ query }) => {
      if (query.kind === "team") {
        return Response.json(inspectionTeam(work));
      }
      if (query.kind === "transcript") {
        return Response.json(inspectionTranscript(work.workId));
      }
      return Response.json(inspectionOverview([work, queued], true));
    },
  });
  const view = fixture.mount();
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Inspect work work-a" }))
  );
  await act(() =>
    view.getByRole("button", { name: "Inspect work work-a" }).click()
  );
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Lead transcript" }))
  );
  await act(() =>
    view.getByRole("button", { name: "Lead transcript" }).click()
  );
  await waitFor(() =>
    assert.ok(view.getByText("SQLite fits this local workflow."))
  );
  await waitFor(() => assert.equal(clock.pending.size, 1));
  const teamReads = fixture.calls.filter(
    ({ query }) => query.kind === "team"
  ).length;
  const transcriptReads = fixture.calls.filter(
    ({ query }) => query.kind === "transcript"
  ).length;
  await clock.next();
  await waitFor(() => assert.equal(clock.pending.size, 1));
  assert.equal(
    fixture.calls.filter(({ query }) => query.kind === "team").length,
    teamReads
  );
  assert.equal(
    fixture.calls.filter(({ query }) => query.kind === "transcript").length,
    transcriptReads
  );
  assert.equal(fixture.calls.at(-1)?.query.kind, "overview");
});

test("selected unsealed Team refreshes until sealing even when overview has no reservation", async () => {
  const work = inspectionWork();
  let teamReads = 0;
  const fixture = inspectorFixture({
    respond: ({ query }) => {
      if (query.kind === "team") {
        teamReads += 1;
        return Response.json(
          inspectionTeam(work, { sealed: teamReads >= 2, phase: "completed" })
        );
      }
      return Response.json(inspectionOverview([work]));
    },
  });
  const view = fixture.mount();
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Inspect work work-a" }))
  );
  await act(() =>
    view.getByRole("button", { name: "Inspect work work-a" }).click()
  );
  await waitFor(() => assert.equal(clock.pending.size, 1));
  await clock.next();
  await waitFor(() => assert.equal(teamReads, 2));
  await waitFor(() => assert.equal(clock.pending.size, 0));
});

test.each(["transcript", "tools", "tasks"] as const)(
  "selected %s gets its final page when the Team seals and later polls read only the overview",
  async (section) => {
    const work = inspectionWork();
    const queued = inspectionWork("queued", {
      status: "queued",
      dispatched: false,
    });
    let sealed = false;
    const fixture = inspectorFixture({
      respond: ({ query }) => {
        if (query.kind === "team") {
          return Response.json(
            inspectionTeam(work, {
              sealed,
              phase: sealed ? "completed" : "running",
            })
          );
        }
        if (query.kind === "tasks") {
          const frame = inspectionTasks(work.workId, query.role);
          return Response.json({
            ...frame,
            tasks: frame.tasks.map((task) => ({
              ...task,
              status: sealed ? "terminal" : "running",
              outcome: sealed ? "completed" : null,
              endedAt: sealed ? 1_800_000_003_000 : null,
            })),
          });
        }
        if (query.kind === "transcript") {
          const frame = inspectionTranscript(work.workId, query.role);
          const content = {
            text: sealed ? "Final private answer" : "Partial private answer",
            truncated: false,
          };
          return Response.json({
            ...frame,
            messages: frame.messages.map((message) => ({
              ...message,
              content,
              state: sealed ? "complete" : "streaming",
            })),
            tools: frame.tools.slice(0, 1).map((tool) => ({
              ...tool,
              status: sealed ? "succeeded" : "running",
              output: content,
            })),
          });
        }
        return Response.json(inspectionOverview([work, queued], true));
      },
    });
    const view = fixture.mount();
    await waitFor(() =>
      assert.ok(view.getByRole("button", { name: "Inspect work work-a" }))
    );
    await act(() =>
      view.getByRole("button", { name: "Inspect work work-a" }).click()
    );
    const label =
      section === "tasks" ? "Lead tasks and retries" : `Lead ${section}`;
    await waitFor(() => assert.ok(view.getByRole("button", { name: label })));
    await act(() => view.getByRole("button", { name: label }).click());
    await waitFor(() =>
      assert.match(
        view.getByRole("region", { name: "Lead details" }).textContent ?? "",
        section === "tasks" ? /running/u : /Partial private answer/u
      )
    );
    await waitFor(() => assert.equal(clock.pending.size, 1));
    sealed = true;
    await clock.next();
    await waitFor(() =>
      assert.match(
        view.getByRole("region", { name: "Lead details" }).textContent ?? "",
        section === "tasks" ? /terminal/u : /Final private answer/u
      )
    );
    assert.equal(
      view.getByText("Cleanup sealed").nextElementSibling?.textContent,
      "Yes"
    );
    const detailReads = fixture.calls.filter(
      ({ query }) => query.kind !== "overview"
    ).length;
    assert.equal(detailReads, 4);
    await waitFor(() => assert.equal(clock.pending.size, 1));
    await clock.next();
    await waitFor(() => assert.equal(clock.pending.size, 1));
    await clock.next();
    await waitFor(() => assert.equal(clock.pending.size, 1));
    assert.equal(fixture.calls.at(-1)?.query.kind, "overview");
    assert.equal(
      fixture.calls.filter(({ query }) => query.kind !== "overview").length,
      detailReads
    );
    await act(() =>
      view.getByRole("button", { name: "Refresh Inspector" }).click()
    );
    await waitFor(() =>
      assert.equal(
        fixture.calls.filter(({ query }) => query.kind !== "overview").length,
        6
      )
    );
    await waitFor(() => assert.equal(clock.pending.size, 1));
  }
);

test.each(["failed", "unavailable"] as const)(
  "a prior %s Team summary still refreshes the open role page when it becomes sealed",
  async (previous) => {
    const work = inspectionWork();
    let teamReads = 0;
    const fixture = inspectorFixture({
      respond: ({ query }) => {
        if (query.kind === "team") {
          teamReads += 1;
          if (teamReads === 2) {
            return previous === "failed"
              ? Response.json({ message: "Unavailable" }, { status: 503 })
              : Response.json({
                  ...inspectionTeam(work),
                  team: {
                    kind: "unavailable",
                    reason: "execution-unavailable",
                  },
                });
          }
          return Response.json(
            inspectionTeam(work, {
              phase: teamReads >= 3 ? "completed" : "running",
              sealed: teamReads >= 3,
            })
          );
        }
        if (query.kind === "transcript") {
          const frame = inspectionTranscript(work.workId, query.role);
          return Response.json({
            ...frame,
            messages: frame.messages.map((message) => ({
              ...message,
              content: {
                text:
                  teamReads >= 3
                    ? "Recovered final answer"
                    : "Partial private answer",
                truncated: false,
              },
              state: teamReads >= 3 ? "complete" : "streaming",
            })),
          });
        }
        return Response.json(inspectionOverview([work], true));
      },
    });
    const view = fixture.mount();
    await waitFor(() =>
      assert.ok(view.getByRole("button", { name: "Inspect work work-a" }))
    );
    await act(() =>
      view.getByRole("button", { name: "Inspect work work-a" }).click()
    );
    await waitFor(() =>
      assert.ok(view.getByRole("button", { name: "Lead transcript" }))
    );
    await act(() =>
      view.getByRole("button", { name: "Lead transcript" }).click()
    );
    await waitFor(() => assert.ok(view.getAllByText("Partial private answer")));
    await waitFor(() => assert.equal(clock.pending.size, 1));
    await clock.next();
    await waitFor(() =>
      assert.ok(
        view.getByText(
          previous === "failed"
            ? "Inspector is unavailable. Refresh to retry."
            : "Private Team details are unavailable. Source work remains visible."
        )
      )
    );
    await waitFor(() => assert.equal(clock.pending.size, 1));
    await clock.next();
    await waitFor(() => assert.ok(view.getAllByText("Recovered final answer")));
    assert.equal(view.queryByText("Partial private answer"), null);
    assert.equal(
      fixture.calls.filter(({ query }) => query.kind === "transcript").length,
      2
    );
    await waitFor(() => assert.equal(clock.pending.size, 1));
    await clock.next();
    await waitFor(() => assert.equal(clock.pending.size, 1));
    assert.equal(teamReads, 3);
    assert.equal(
      fixture.calls.filter(({ query }) => query.kind === "transcript").length,
      2
    );
  }
);

test("work and role changes abort their old reads and unmount clears the only timer", async () => {
  const held = Promise.withResolvers<Response>();
  const work = inspectionWork();
  const fixture = inspectorFixture({
    respond: async ({ query }) => {
      if (query.kind === "team") {
        return Response.json(
          inspectionTeam(work, { phase: "running", sealed: false })
        );
      }
      if (query.kind === "transcript") {
        return query.role === 0
          ? await held.promise
          : Response.json(inspectionTranscript(work.workId, query.role));
      }
      return Response.json(inspectionOverview([work], true));
    },
  });
  const view = fixture.mount();
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Inspect work work-a" }))
  );
  await act(() =>
    view.getByRole("button", { name: "Inspect work work-a" }).click()
  );
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Lead transcript" }))
  );
  await act(() =>
    view.getByRole("button", { name: "Lead transcript" }).click()
  );
  await waitFor(() =>
    assert.equal(fixture.calls.at(-1)?.query.kind, "transcript")
  );
  const old = fixture.calls.at(-1)?.signal;
  assert.equal(clock.pending.size, 0);
  await act(() =>
    view.getByRole("button", { name: "Worker 1 transcript" }).click()
  );
  assert.equal(old?.aborted, true);
  await waitFor(() =>
    assert.ok(view.getByRole("region", { name: "Worker 1 details" }))
  );
  await waitFor(() => assert.equal(clock.pending.size, 1));
  await act(async () => {
    held.resolve(Response.json(inspectionTranscript(work.workId, 0)));
    await delay(0);
  });
  assert.equal(view.queryByRole("region", { name: "Lead details" }), null);
  view.unmount();
  assert.equal(clock.pending.size, 0);
  assert.ok(fixture.calls.every(({ signal }) => signal?.aborted));
});

test("user and source changes remove the prior Inspector before loading another source", async () => {
  const held = Promise.withResolvers<Response>();
  const work = inspectionWork();
  const fixture = inspectorFixture({
    respond: async ({ query }) =>
      query.kind === "team"
        ? await held.promise
        : Response.json(inspectionOverview([work])),
  });
  const view = fixture.mount();
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Inspect work work-a" }))
  );
  await act(() =>
    view.getByRole("button", { name: "Inspect work work-a" }).click()
  );
  await waitFor(() => assert.equal(fixture.calls.length, 2));
  const oldSignal = fixture.calls[1]?.signal;
  await act(() => view.rerender(fixture.element({ userId: "other-user" })));
  assert.equal(oldSignal?.aborted, true);
  await waitFor(() => assert.equal(fixture.calls.length, 3));
  await act(async () => {
    held.resolve(Response.json(inspectionTeam(work)));
    await delay(0);
  });
  assert.equal(view.queryByText("Saved result work-a"), null);
  await act(() =>
    view.rerender(fixture.element({ conversationId: "other-conversation" }))
  );
  assert.equal(
    view.queryByRole("region", { name: "Development Inspector" }),
    null
  );
  assert.ok(fixture.calls.every(({ signal }) => signal?.aborted));
  assert.equal(clock.pending.size, 0);
  assert.ok(view.getByText("The conversation does not belong to this agent."));
  assert.notEqual(inspectionAddress.conversationId, "other-conversation");
});
