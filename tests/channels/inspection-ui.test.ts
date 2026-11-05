import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  inspectionAddress,
  inspectionOverview,
  inspectionProfile,
  inspectionSnapshot,
  inspectionTasks,
  inspectionTeam,
  inspectionTranscript,
  inspectionWork,
} from "./inspection-ui-data.ts";
import {
  act,
  cleanupInspectionDom,
  clearProductCache,
  currentAccessGeneration,
  inspectorFixture,
  installInspectionDom,
  waitFor,
} from "./inspection-ui-fixture.ts";

beforeEach(installInspectionDom);
afterEach(cleanupInspectionDom);

test("local Inspector opens with one overview, keeps the composer enabled and loads one selected Team lazily", async () => {
  const first = inspectionWork();
  const second = inspectionWork("work-b");
  const fixture = inspectorFixture({
    respond: ({ query }) =>
      Response.json(
        query.kind === "team"
          ? inspectionTeam(query.workId === first.workId ? first : second)
          : inspectionOverview([first, second])
      ),
  });
  const view = fixture.mount();
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Inspect work work-a" }))
  );
  assert.deepEqual(
    fixture.calls.map(({ query }) => query),
    [{ kind: "overview" }]
  );
  assert.equal(
    view.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Message",
      exact: true,
    }).disabled,
    false
  );
  assert.equal(
    view
      .getByRole("button", { name: "Inspector", exact: true })
      .getAttribute("aria-expanded"),
    "true"
  );
  await act(() =>
    view.getByRole("button", { name: "Inspect work work-a" }).click()
  );
  await waitFor(() => assert.ok(view.getByText("strong-model")));
  assert.equal(view.getAllByText("cheap-model").length, 2);
  assert.equal(view.getByText("8 / 20").textContent, "8 / 20");
  assert.ok(view.getByText("Unavailable", { exact: true }));
  assert.ok(view.getByText("Saved result work-a"));
  assert.ok(view.getByText("Text truncated."));
  assert.deepEqual(
    fixture.calls.map(({ query }) => query),
    [{ kind: "overview" }, { kind: "team", workId: first.workId }]
  );
  assert.ok(view.getByRole("article", { name: "Lead conversation" }));
  assert.ok(view.getByRole("article", { name: "Worker 1 conversation" }));
  assert.ok(view.getByRole("article", { name: "Worker 2 conversation" }));
  await act(() =>
    view.getByRole("button", { name: "Inspect work work-b" }).click()
  );
  await waitFor(() => assert.ok(view.getByText("Saved result work-b")));
  assert.equal(view.queryByText("Saved result work-a"), null);
  await act(() =>
    view.getByRole("button", { name: "Inspector", exact: true }).click()
  );
  assert.equal(view.queryByText("Saved result work-b"), null);
});

test("production Inspector stays closed and closed historical admission remains inspectable", async () => {
  const fixture = inspectorFixture({
    mode: "production",
    snapshot: inspectionSnapshot({
      admission: {
        kind: "closed",
        phase: "archived",
        primary: inspectionAddress,
      },
    }),
  });
  const view = fixture.mount();
  await waitFor(() =>
    assert.ok(
      view.getByText(/This historical conversation accepts no new messages/u)
    )
  );
  assert.equal(
    view.queryByRole("textbox", { name: "Message", exact: true }),
    null
  );
  assert.equal(fixture.calls.length, 0);
  await act(() =>
    view.getByRole("button", { name: "Inspector", exact: true }).click()
  );
  await waitFor(() => assert.equal(fixture.calls.length, 1));
  assert.ok(view.getByText("Select work to inspect"));
});

test("role transcript, safe tools, tasks and saved usage use bounded lazy queries", async () => {
  const work = inspectionWork();
  const fixture = inspectorFixture({
    respond: ({ query }) => {
      if (query.kind === "team") {
        return Response.json(inspectionTeam(work));
      }
      if (query.kind === "transcript") {
        return Response.json(
          query.cursor
            ? {
                ...inspectionTranscript(work.workId, query.role),
                messages: [],
                tools: [],
                next: null,
              }
            : inspectionTranscript(work.workId, query.role)
        );
      }
      if (query.kind === "tasks") {
        return Response.json(inspectionTasks(work.workId, query.role));
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
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Lead transcript" }))
  );
  await act(() =>
    view.getByRole("button", { name: "Lead transcript" }).click()
  );
  await waitFor(() =>
    assert.ok(view.getByText("SQLite fits this local workflow."))
  );
  assert.ok(view.getByText(/saved-answer-model/u));
  const beforeTools = fixture.calls.length;
  await act(() => view.getByRole("button", { name: "Lead tools" }).click());
  assert.equal(fixture.calls.length, beforeTools);
  assert.ok(view.getByText("Check database recovery."));
  assert.ok(view.getByText("WAL preserves committed writes."));
  assert.ok(view.getByText("Input unavailable."));
  assert.ok(view.getByText("tool-result-a"));
  await act(() =>
    view.getByRole("button", { name: "Older role entries" }).click()
  );
  await waitFor(() => assert.ok(view.getByText("No tools on this page.")));
  assert.equal(view.queryByText("WAL preserves committed writes."), null);
  assert.deepEqual(fixture.calls.at(-1)?.query, {
    kind: "transcript",
    role: 0,
    workId: work.workId,
    cursor: "older-transcript",
  });
  await act(() =>
    view.getByRole("button", { name: "Worker 1 tasks and retries" }).click()
  );
  await waitFor(() => assert.ok(view.getByText("pi.generation")));
  assert.ok(view.getByText("task-a"));
  assert.ok(view.getByText("owner-task"));
  assert.deepEqual(fixture.calls.at(-1)?.query, {
    kind: "tasks",
    role: 1,
    workId: work.workId,
  });
  const leadUsage = view.getByText("Lead token usage").closest("details");
  assert.ok(leadUsage);
  assert.match(
    leadUsage.textContent ?? "",
    /Input tokens101.*Output tokens37.*Cache read tokens11.*Cache write tokens7.*Total tokens156/u
  );
});

test("a tool call without a result on its page shows unknown status and page-local output text", async () => {
  const work = inspectionWork();
  const transcript = inspectionTranscript(work.workId);
  const [tool] = transcript.tools;
  assert.ok(tool);
  const fixture = inspectorFixture({
    respond: ({ query }) => {
      if (query.kind === "team") {
        return Response.json(inspectionTeam(work));
      }
      if (query.kind === "transcript") {
        return Response.json({
          ...transcript,
          tools: [
            { ...tool, status: "unknown", output: null, resultEntryId: null },
          ],
        });
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
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Lead tools" }))
  );
  await act(() => view.getByRole("button", { name: "Lead tools" }).click());
  await waitFor(() =>
    assert.ok(view.getByRole("article", { name: "delegate_worker unknown" }))
  );
  assert.ok(view.getByText("Output unavailable on this page."));
  assert.ok(view.getByText("Check database recovery."));
  assert.equal(view.queryByText("No saved output."), null);
  assert.deepEqual(
    fixture.calls.map(({ query }) => query),
    [
      { kind: "overview" },
      { kind: "team", workId: work.workId },
      { kind: "transcript", workId: work.workId, role: 0 },
    ]
  );
});

test("reused provider call IDs keep separate stable tool rows and preserve completed output across refresh", async () => {
  const work = inspectionWork();
  const transcript = inspectionTranscript(work.workId);
  const [tool] = transcript.tools;
  assert.ok(tool);
  let completed = false;
  const fixture = inspectorFixture({
    respond: ({ query }) => {
      if (query.kind === "team") {
        return Response.json(inspectionTeam(work));
      }
      if (query.kind === "transcript") {
        return Response.json({
          ...transcript,
          tools: [
            { ...tool, id: "call:11:0:0", callId: "reused-provider-call" },
            {
              ...tool,
              id: "call:22:0:0",
              callId: "reused-provider-call",
              status: completed ? "succeeded" : "running",
              output: completed
                ? { text: "The second check is complete.", truncated: false }
                : null,
              resultEntryId: completed ? "second-result" : null,
            },
          ],
        });
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
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Lead tools" }))
  );
  await act(() => view.getByRole("button", { name: "Lead tools" }).click());
  await waitFor(() =>
    assert.equal(view.getAllByText("reused-provider-call").length, 2)
  );
  const first = view.getByRole("article", {
    name: "delegate_worker succeeded",
  });
  const second = view.getByRole("article", { name: "delegate_worker running" });
  assert.match(first.textContent ?? "", /WAL preserves committed writes/u);
  assert.equal(
    second.textContent?.includes("WAL preserves committed writes"),
    false
  );
  assert.equal(view.queryByText("call:11:0:0"), null);
  completed = true;
  await act(() =>
    view.getByRole("button", { name: "Refresh Inspector" }).click()
  );
  await waitFor(() =>
    assert.ok(view.getByText("The second check is complete."))
  );
  assert.equal(
    view.getByText("WAL preserves committed writes.").closest("article"),
    first
  );
  assert.equal(
    view.getByText("The second check is complete.").closest("article"),
    second
  );
  assert.equal(
    view.getAllByRole("article", { name: "delegate_worker succeeded" }).length,
    2
  );
  assert.equal(view.getAllByText("reused-provider-call").length, 2);
  assert.equal(first.textContent?.includes("second-result"), false);
  assert.ok(view.getByText("second-result"));
});

test("work history and owned events keep empty-page continuations and replace old pages", async () => {
  const old = inspectionWork("old-work");
  const recent = inspectionWork("recent-work");
  const fixture = inspectorFixture({
    respond: ({ query }) => {
      if (query.kind === "history") {
        return Response.json({
          address: inspectionAddress,
          profile: inspectionProfile,
          kind: "history",
          work: query.cursor ? [old, recent] : [],
          next: query.cursor ? null : "history-next",
        });
      }
      if (query.kind === "events") {
        return Response.json({
          address: inspectionAddress,
          profile: inspectionProfile,
          kind: "events",
          next: query.cursor ? null : "events-next",
          events: query.cursor
            ? [
                {
                  id: "event-a",
                  source: "slack",
                  route: "teams",
                  duplicates: 3,
                  admission: "delivered",
                  outcome: "returned",
                  workIds: [old.workId],
                  returns: [{ workId: old.workId, decision: "coordinator" }],
                  reply: {
                    answerEntryId: "answer-entry",
                    taskId: "reply-task",
                    state: "unknown",
                    attempts: 1,
                    deadlineAt: 1_800_000_001_000,
                    retryAt: null,
                    timestamp: null,
                  },
                },
              ]
            : [],
        });
      }
      return Response.json(inspectionOverview([recent]));
    },
  });
  const view = fixture.mount();
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Work history" }))
  );
  await act(() => view.getByRole("button", { name: "Work history" }).click());
  await waitFor(() =>
    assert.equal(
      view.getByRole<HTMLButtonElement>("button", { name: "Older work" })
        .disabled,
      false
    )
  );
  await act(() => view.getByRole("button", { name: "Older work" }).click());
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Inspect work old-work" }))
  );
  assert.equal(
    view.getAllByRole("button", { name: "Inspect work recent-work" }).length,
    1
  );
  await act(() => view.getByRole("button", { name: "Latest work" }).click());
  await waitFor(() =>
    assert.equal(
      view.queryByRole("button", { name: "Inspect work old-work" }),
      null
    )
  );
  await act(() => view.getByRole("button", { name: "Owned events" }).click());
  await waitFor(() =>
    assert.equal(
      view.getByRole<HTMLButtonElement>("button", { name: "Older events" })
        .disabled,
      false
    )
  );
  await act(() => view.getByRole("button", { name: "Older events" }).click());
  await waitFor(() => assert.ok(view.getByText("event-a")));
  assert.ok(view.getByText("unknown"));
  assert.ok(view.getByText("answer-entry"));
  assert.deepEqual(
    fixture.calls
      .filter(({ query }) => query.kind === "history")
      .map(({ query }) => query),
    [
      { kind: "history" },
      { kind: "history", cursor: "history-next" },
      { kind: "history" },
    ]
  );
});

test("not-started and unavailable Team states show source metadata without role requests", async () => {
  const queued = inspectionWork("queued", {
    status: "queued",
    dispatched: false,
  });
  const unavailable = inspectionWork("unavailable");
  const fixture = inspectorFixture({
    respond: ({ query }) => {
      if (query.kind === "team") {
        return Response.json({
          ...inspectionTeam(
            query.workId === queued.workId ? queued : unavailable
          ),
          team:
            query.workId === queued.workId
              ? { kind: "not-started" }
              : { kind: "unavailable", reason: "execution-unavailable" },
        });
      }
      return Response.json(inspectionOverview([queued, unavailable]));
    },
  });
  const view = fixture.mount();
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Inspect work queued" }))
  );
  await act(() =>
    view.getByRole("button", { name: "Inspect work queued" }).click()
  );
  await waitFor(() => assert.ok(view.getByText(/This work has not started/u)));
  await act(() =>
    view.getByRole("button", { name: "Inspect work unavailable" }).click()
  );
  await waitFor(() =>
    assert.ok(view.getByText(/Private Team details are unavailable/u))
  );
  assert.deepEqual(
    fixture.calls.map(({ query }) => query.kind),
    ["overview", "team", "team"]
  );
});

for (const fault of ["address", "work", "role", "extra", "kind"] as const) {
  test(`Inspector rejects a ${fault} response fault without rendering parser data`, async () => {
    const work = inspectionWork();
    const fixture = inspectorFixture({
      respond: ({ query }) => {
        if (query.kind === "overview") {
          return Response.json(inspectionOverview([work]));
        }
        if (query.kind === "team") {
          if (fault === "work") {
            return Response.json(
              inspectionTeam(inspectionWork("foreign-work"))
            );
          }
          if (fault === "address") {
            return Response.json({
              ...inspectionTeam(work),
              address: { ...inspectionAddress, sessionId: "foreign-session" },
            });
          }
          if (fault === "extra") {
            return Response.json({
              ...inspectionTeam(work),
              thinking: "FORBIDDEN_SENTINEL",
            });
          }
          if (fault === "kind") {
            return Response.json(inspectionOverview());
          }
          return Response.json(inspectionTeam(work));
        }
        return Response.json({ ...inspectionTranscript(work.workId), role: 1 });
      },
    });
    const view = fixture.mount();
    await waitFor(() =>
      assert.ok(view.getByRole("button", { name: "Inspect work work-a" }))
    );
    await act(() =>
      view.getByRole("button", { name: "Inspect work work-a" }).click()
    );
    if (fault === "role") {
      await waitFor(() =>
        assert.ok(view.getByRole("button", { name: "Lead transcript" }))
      );
      await act(() =>
        view.getByRole("button", { name: "Lead transcript" }).click()
      );
    }
    await waitFor(() =>
      assert.ok(view.getByText("Inspector is unavailable. Refresh to retry."))
    );
    assert.equal(view.queryByText(/FORBIDDEN_SENTINEL/u), null);
    assert.equal(view.queryByText("SQLite fits this local workflow."), null);
  });
}

test("closing and changing work abort stale requests before their private response can render", async () => {
  const held = Promise.withResolvers<Response>();
  const first = inspectionWork();
  const second = inspectionWork("work-b");
  const fixture = inspectorFixture({
    respond: async ({ query }) => {
      if (query.kind === "team") {
        return query.workId === first.workId
          ? await held.promise
          : Response.json(inspectionTeam(second));
      }
      return Response.json(inspectionOverview([first, second]));
    },
  });
  const view = fixture.mount();
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Inspect work work-a" }))
  );
  await act(() =>
    view.getByRole("button", { name: "Inspect work work-a" }).click()
  );
  await waitFor(() => assert.equal(fixture.calls.length, 2));
  const firstSignal = fixture.calls[1]?.signal;
  await act(() =>
    view.getByRole("button", { name: "Inspect work work-b" }).click()
  );
  assert.equal(firstSignal?.aborted, true);
  await waitFor(() => assert.ok(view.getByText("Saved result work-b")));
  await act(async () => {
    held.resolve(Response.json(inspectionTeam(first)));
    await delay(0);
  });
  assert.equal(view.queryByText("Saved result work-a"), null);
  await act(() =>
    view.getByRole("button", { name: "Inspector", exact: true }).click()
  );
  assert.equal(fixture.calls.at(-1)?.signal?.aborted, true);
  assert.equal(view.queryByText("Saved result work-b"), null);
});

for (const status of [401, 403] as const) {
  test(`Inspector HTTP ${status} clears private data and all pending reads`, async () => {
    let deny = false;
    const work = inspectionWork();
    const fixture = inspectorFixture({
      respond: ({ query }) =>
        deny
          ? Response.json({ message: "Denied" }, { status })
          : Response.json(
              query.kind === "team"
                ? inspectionTeam(work)
                : inspectionOverview([work])
            ),
    });
    const view = fixture.mount();
    await waitFor(() =>
      assert.ok(view.getByRole("button", { name: "Inspect work work-a" }))
    );
    await act(() =>
      view.getByRole("button", { name: "Inspect work work-a" }).click()
    );
    await waitFor(() => assert.ok(view.getByText("Saved result work-a")));
    deny = true;
    await act(() =>
      view.getByRole("button", { name: "Refresh Inspector" }).click()
    );
    await waitFor(() =>
      assert.ok(view.getByText("Conversation access is no longer available."))
    );
    assert.equal(view.queryByText("Saved result work-a"), null);
    assert.ok(fixture.calls.every(({ signal }) => signal?.aborted));
  });
}

test("signout clears an open Inspector and rejects a delayed private response", async () => {
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
  const generation = currentAccessGeneration();
  await act(() => clearProductCache());
  assert.equal(currentAccessGeneration(), generation + 1);
  await act(async () => {
    held.resolve(Response.json(inspectionTeam(work)));
    await delay(0);
  });
  assert.equal(view.queryByText("Saved result work-a"), null);
  assert.ok(view.getByText("Conversation access is no longer available."));
});

test("a cancelled Inspector denial cannot clear a newer work selection", async () => {
  const held = Promise.withResolvers<Response>();
  const first = inspectionWork();
  const second = inspectionWork("work-b");
  const fixture = inspectorFixture({
    respond: async ({ query }) => {
      if (query.kind === "team") {
        return query.workId === first.workId
          ? await held.promise
          : Response.json(inspectionTeam(second));
      }
      return Response.json(inspectionOverview([first, second]));
    },
  });
  const view = fixture.mount();
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: "Inspect work work-a" }))
  );
  await act(() =>
    view.getByRole("button", { name: "Inspect work work-a" }).click()
  );
  await waitFor(() => assert.equal(fixture.calls.length, 2));
  await act(() =>
    view.getByRole("button", { name: "Inspect work work-b" }).click()
  );
  await waitFor(() => assert.ok(view.getByText("Saved result work-b")));
  const generation = currentAccessGeneration();
  await act(async () => {
    held.resolve(
      Response.json({ message: "Old denied read" }, { status: 403 })
    );
    await delay(0);
  });
  assert.equal(currentAccessGeneration(), generation);
  assert.ok(view.getByText("Saved result work-b"));
});
