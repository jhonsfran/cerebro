import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { LifecycleJob, LifecycleJobs } from "agents/lifecycle";
import { Schema } from "effect";

import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
} from "../../packages/contracts/src/failures.ts";
import {
  ChatReminder,
  ChatSnapshot,
} from "../../packages/contracts/src/session-service.ts";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import {
  ReminderPayload,
  createConversationReminders,
} from "../../packages/runtime/src/conversation-reminders.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const fakeJobs = () => {
  const rows = new Map<string, LifecycleJob>();
  let failAfterPush = false;
  const jobs: LifecycleJobs = {
    cancel: (id) => Promise.resolve(rows.delete(id)),
    get: (id) => rows.get(id),
    list: () => [...rows.values()],
    push: (options) => {
      assert.ok(options.id);
      const job: LifecycleJob = {
        capability: "host",
        createdAt: 0,
        exclusive: options.exclusive ?? false,
        fn: options.fn,
        id: options.id,
        payload: structuredClone(options.payload),
        recoveryLoop: options.recoveryLoop ?? false,
        retry: options.retry,
        singleflight: options.singleflight ?? false,
        time: options.time,
      };
      rows.set(job.id, job);
      if (failAfterPush) {
        failAfterPush = false;
        return Promise.reject(new Error("Lost job admission response"));
      }
      return Promise.resolve(job);
    },
    rearm: () => Promise.resolve(),
    reschedule: (id, time) => {
      const row = rows.get(id);
      if (!row) {
        return Promise.resolve(false);
      }
      rows.set(id, { ...row, time });
      return Promise.resolve(true);
    },
  };
  return {
    failNextPush: () => {
      failAfterPush = true;
    },
    jobs,
    rows,
  };
};

const setup = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cerebro-reminders-"));
  const databasePath = path.join(directory, "state.sqlite");
  const queued = fakeJobs();
  let clock = Date.parse("2026-10-21T12:00:00Z");
  let allowed = true;
  let lostSubmit = false;
  let pause:
    | {
        readonly entered: PromiseWithResolvers<boolean>;
        readonly release: PromiseWithResolvers<boolean>;
      }
    | undefined;
  const models = createModels();
  const faux = fauxProvider({
    models: [{ id: "test" }],
    provider: "reminder-test",
  });
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 30 }, () =>
      fauxAssistantMessage("Scheduled work completed.")
    )
  );
  const open = async () => {
    const storage = await openNodeSqliteStorage(databasePath);
    const registry = createRegistry();
    const pi = await Harness.open(
      storage,
      { models, registry, settings: { extensions: [] } },
      piContext()
    );
    return { pi, registry, storage };
  };
  let host = await open();
  const first = await host.pi.createConversation(
    {
      agent: { model: { modelId: "test", provider: "reminder-test" } },
      ownership: { kind: "ownerless" },
    },
    piContext()
  );
  const second = await host.pi.createConversation(
    {
      agent: { model: { modelId: "test", provider: "reminder-test" } },
      ownership: { kind: "ownerless" },
    },
    piContext()
  );
  const bind = (nativeId: typeof first.id, sessionId: string) =>
    createConversationReminders({
      authorize: () =>
        allowed
          ? Promise.resolve()
          : Promise.reject(
              new Denied({ code: "revoked", reason: "Access was revoked." })
            ),
      jobs: queued.jobs,
      metadata: (operation) => host.pi.commit(operation, piContext()),
      nativeId,
      now: () => clock,
      persist: () => Promise.resolve(),
      pi: host.pi,
      sessionId,
      submit: async (text, operationId) => {
        if (pause) {
          pause.entered.resolve(true);
          await pause.release.promise;
        }
        const native = await host.pi.conversation(nativeId, piContext());
        assert.ok(native);
        const submission = await native.submit(
          {
            content: text,
            requestId: operationId,
            type: "input",
            whenBusy: "followUp",
          },
          piContext()
        );
        if (lostSubmit) {
          lostSubmit = false;
          throw new Error("Lost native submit response");
        }
        return submission;
      },
    });
  let reminders = bind(first.id, "first");
  let sibling = bind(second.id, "second");
  return {
    close: async () => {
      pause?.release.resolve(true);
      await host.pi.close(piContext());
      await rm(directory, { recursive: true });
    },
    due: async (row: LifecycleJob) => {
      const payload = Schema.decodeUnknownSync(ReminderPayload)(row.payload);
      return await reminders.deliver(
        payload.reminderId,
        payload.occurrence,
        payload.input
      );
    },
    jobs: queued.jobs,
    losePush: queued.failNextPush,
    loseSubmit: () => {
      lostSubmit = true;
    },
    invokeTool: async (name: string, args: Record<string, unknown>) => {
      const extension = { name: "test-reminders", tools: reminders.tools };
      host.registry.install(extension);
      const native = await host.pi.conversation(first.id, piContext());
      assert.ok(native);
      await native.configure({ extensions: [extension] }, piContext());
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall(name, args), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("The reminder was updated."),
      ]);
      const submission = await native.submit(
        { content: "Update a reminder.", type: "input" },
        piContext()
      );
      return await submission.wait(piContext());
    },
    now: () => clock,
    pauseSubmit: () => {
      pause = {
        entered: Promise.withResolvers<boolean>(),
        release: Promise.withResolvers<boolean>(),
      };
      return {
        entered: pause.entered.promise,
        release: () => pause?.release.resolve(true),
      };
    },
    reminders: () => reminders,
    reopen: async () => {
      await host.pi.close(piContext());
      host = await open();
      reminders = bind(first.id, "first");
      sibling = bind(second.id, "second");
      await reminders.restore();
      await sibling.restore();
    },
    revoke: () => {
      allowed = false;
    },
    setTime: (value: number) => {
      clock = value;
    },
    sibling: () => sibling,
    stop: async () => {
      const native = await host.pi.conversation(first.id, piContext());
      assert.ok(native);
      await native.abort(piContext());
    },
    submissions: async () => {
      await host.pi.waitForIdle(piContext());
      const submissions = await host.storage.scanSubmissions(
        { conversationId: first.id },
        100,
        undefined,
        piContext()
      );
      return submissions.items.map((value) => ({
        requestId: value.requestId,
        status: value.status,
      }));
    },
    transcript: async () => {
      const native = await host.pi.conversation(first.id, piContext());
      assert.ok(native);
      return await native.context(piContext());
    },
  };
};

test("reminder creation is idempotent and rejects changed input under the same operation ID", async () => {
  const fixture = await setup();
  try {
    const input = {
      instruction: "Review the issue.",
      runAt: fixture.now() + 1000,
    };
    const first = await fixture.reminders().schedule(input, "create");
    assert.deepEqual(
      await fixture.reminders().schedule(input, "create"),
      first
    );
    await assert.rejects(
      fixture
        .reminders()
        .schedule({ ...input, instruction: "Another issue." }, "create"),
      Conflict
    );
    assert.deepEqual(await fixture.reminders().list(), [
      {
        id: "reminder:create",
        instruction: "Review the issue.",
        runAt: input.runAt,
        state: "scheduled",
      },
    ]);
    assert.equal(fixture.jobs.list().length, 1);
  } finally {
    await fixture.close();
  }
});

test("native model tools schedule relative deadlines and cancel them", async () => {
  const fixture = await setup();
  try {
    const scheduleResult = await fixture.invokeTool("schedule", {
      delaySeconds: 60,
      instruction: "Check my queue.",
    });
    assert.equal(scheduleResult.status, "done");
    const [scheduled] = await fixture.reminders().list();
    assert.ok(scheduled);
    assert.equal(scheduled.instruction, "Check my queue.");
    assert.equal(scheduled.runAt, Date.parse("2026-10-21T12:01:00Z"));
    assert.equal(scheduled.state, "scheduled");
    const cancellation = await fixture.invokeTool("cancel_schedule", {
      id: scheduled.id,
    });
    assert.equal(cancellation.status, "done");
    const reminders = await fixture.reminders().list();
    assert.equal(reminders[0]?.state, "cancelled");
    assert.equal(fixture.jobs.list().length, 0);
  } finally {
    await fixture.close();
  }
});

test("a durable wake recovers creation interrupted before native reminder admission", async () => {
  const fixture = await setup();
  try {
    const runAt = fixture.now() + 1000;
    fixture.losePush();
    await assert.rejects(
      fixture
        .reminders()
        .schedule({ instruction: "Recover me.", runAt }, "gap"),
      /Lost job/u
    );
    const [job] = fixture.jobs.list();
    assert.ok(job);
    assert.deepEqual(await fixture.reminders().list(), []);
    await fixture.reopen();
    fixture.setTime(runAt);
    await fixture.due(job);
    assert.deepEqual(await fixture.reminders().list(), [
      {
        id: "reminder:gap",
        instruction: "Recover me.",
        lastDeliveredAt: runAt,
        runAt,
        state: "completed",
      },
    ]);
    assert.deepEqual(await fixture.submissions(), [
      { requestId: `reminder:gap:${runAt}`, status: "done" },
    ]);
  } finally {
    await fixture.close();
  }
});

test("lost native submission response and restart deliver one input", async () => {
  const fixture = await setup();
  try {
    const runAt = fixture.now() + 1000;
    await fixture
      .reminders()
      .schedule({ instruction: "Send once.", runAt }, "once");
    fixture.setTime(runAt);
    fixture.loseSubmit();
    assert.deepEqual(
      await fixture.reminders().deliver("reminder:once", runAt),
      { rescheduleAt: runAt + 5000 }
    );
    await fixture.reopen();
    await fixture.reminders().deliver("reminder:once", runAt);
    assert.deepEqual(await fixture.submissions(), [
      { requestId: `reminder:once:${runAt}`, status: "done" },
    ]);
    const reminders = await fixture.reminders().list();
    assert.equal(reminders[0]?.state, "completed");
  } finally {
    await fixture.close();
  }
});

test("recurrence skips missed deadlines and duplicate old jobs do not replace its new occurrence", async () => {
  const fixture = await setup();
  try {
    const runAt = fixture.now() + 1000;
    const input = {
      instruction: "Check again.",
      recurrence: { interval: 1, timezone: "UTC", unit: "minute" as const },
      runAt,
    };
    await fixture.reminders().schedule(input, "repeat");
    fixture.setTime(runAt + 180_000);
    assert.deepEqual(
      await fixture.reminders().deliver("reminder:repeat", runAt),
      { rescheduleAt: runAt + 240_000 }
    );
    await fixture.reminders().schedule(input, "repeat");
    await fixture.reminders().deliver("reminder:repeat", runAt);
    await fixture.reopen();
    assert.deepEqual(await fixture.reminders().list(), [
      {
        id: "reminder:repeat",
        instruction: "Check again.",
        lastDeliveredAt: runAt,
        recurrence: input.recurrence,
        runAt: runAt + 240_000,
        state: "scheduled",
      },
    ]);
    const [job] = fixture.jobs.list();
    assert.equal(job?.time, runAt + 240_000);
    assert.deepEqual(await fixture.submissions(), [
      { requestId: `reminder:repeat:${runAt}`, status: "done" },
    ]);
  } finally {
    await fixture.close();
  }
});

test("cancelled and revoked reminders do not submit work; sibling reminder IDs stay separate", async () => {
  const fixture = await setup();
  try {
    const runAt = fixture.now() + 1000;
    const cancelled = await fixture
      .reminders()
      .schedule({ instruction: "Cancel this.", runAt }, "same");
    await fixture
      .sibling()
      .schedule({ instruction: "Keep this.", runAt }, "same");
    await fixture.reminders().cancel(cancelled.id);
    fixture.setTime(runAt);
    await fixture.reminders().deliver(cancelled.id, runAt);
    const siblingReminders = await fixture.sibling().list();
    assert.equal(siblingReminders[0]?.state, "scheduled");
    await assert.rejects(fixture.sibling().cancel("missing"), NotFound);
    const revoked = await fixture
      .reminders()
      .schedule(
        { instruction: "Denied later.", runAt: runAt + 1000 },
        "revoked"
      );
    fixture.setTime(runAt + 1000);
    fixture.revoke();
    await fixture.reminders().deliver(revoked.id, runAt + 1000);
    const reminders = await fixture.reminders().list();
    assert.deepEqual(
      reminders.map((value) => value.state),
      ["cancelled", "revoked"]
    );
    assert.deepEqual(await fixture.submissions(), []);
  } finally {
    await fixture.close();
  }
});

test("cancellation waits for an admitted occurrence and prevents its recurring successor", async () => {
  const fixture = await setup();
  try {
    const runAt = fixture.now() + 1000;
    await fixture.reminders().schedule(
      {
        instruction: "Current occurrence.",
        recurrence: { interval: 1, timezone: "UTC", unit: "minute" },
        runAt,
      },
      "race"
    );
    fixture.setTime(runAt);
    const paused = fixture.pauseSubmit();
    const delivery = fixture.reminders().deliver("reminder:race", runAt);
    await paused.entered;
    const cancellation = fixture.reminders().cancel("reminder:race");
    paused.release();
    await delivery;
    const cancelled = await cancellation;
    assert.equal(cancelled.state, "cancelled");
    assert.deepEqual(await fixture.submissions(), [
      { requestId: `reminder:race:${runAt}`, status: "done" },
    ]);
    assert.equal(fixture.jobs.list().length, 0);
    await fixture.reopen();
    const reminders = await fixture.reminders().list();
    assert.deepEqual(
      reminders.map((value) => value.state),
      ["cancelled"]
    );
  } finally {
    await fixture.close();
  }
});

test("Stop retains future reminders and interrupted schedule requests do not create a wake", async () => {
  const fixture = await setup();
  try {
    const runAt = fixture.now() + 1000;
    await assert.rejects(
      fixture
        .reminders()
        .schedule(
          { instruction: "Interrupted request.", runAt },
          "interrupted",
          AbortSignal.abort()
        ),
      { name: "AbortError" }
    );
    assert.equal(fixture.jobs.list().length, 0);
    const reminder = await fixture
      .reminders()
      .schedule({ instruction: "Keep the future reminder.", runAt }, "future");
    await fixture.stop();
    await fixture.reopen();
    const restored = await fixture.reminders().list();
    assert.equal(restored.length, 1);
    fixture.setTime(runAt);
    await fixture.reminders().deliver(reminder.id, runAt);
    assert.deepEqual(await fixture.submissions(), [
      { requestId: `reminder:future:${runAt}`, status: "done" },
    ]);
  } finally {
    await fixture.close();
  }
});

test("maximum reminders have bounded Unicode previews while full instructions and all active wakes survive restart", async () => {
  const fixture = await setup();
  try {
    const fullInstruction = `${"界".repeat(255)}🧠${"界".repeat(31_743)}`;
    assert.equal(fullInstruction.length, 32_000);
    for (let index = 0; index < 20; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Persist terminal history before checking the active reminder limit.
      const retired = await fixture
        .reminders()
        .schedule(
          { instruction: fullInstruction, runAt: fixture.now() + 1000 + index },
          `retired-${index}`
        );
      // oxlint-disable-next-line no-await-in-loop -- Cancel each admitted reminder through its public command.
      await fixture.reminders().cancel(retired.id);
    }
    const runAt = fixture.now() + 60_000;
    for (let index = 0; index < 100; index += 1) {
      const instruction =
        index % 2 === 0 ? fullInstruction : "\u0000".repeat(32_000);
      // oxlint-disable-next-line no-await-in-loop -- Each admission observes the persisted active reminder limit.
      const scheduled = await fixture
        .reminders()
        .schedule({ instruction, runAt }, `active-${index}`);
      assert.equal(scheduled.instruction, instruction);
    }
    await assert.rejects(
      fixture
        .reminders()
        .schedule({ instruction: "Over capacity", runAt }, "overflow"),
      InvalidInput
    );
    const reminders = await fixture.reminders().list();
    assert.equal(
      reminders.filter((reminder) => reminder.state === "scheduled").length,
      100
    );
    assert.deepEqual(
      reminders
        .filter((reminder) => reminder.state === "cancelled")
        .map((reminder) => reminder.id),
      Array.from({ length: 16 }, (_, index) => `reminder:retired-${index + 4}`)
    );
    assert.equal(
      reminders.find((reminder) => reminder.id === "reminder:active-0")
        ?.instruction,
      `${"界".repeat(255)}🧠`
    );
    assert.ok(
      reminders.every((reminder) => [...reminder.instruction].length <= 256)
    );
    const snapshot = Schema.decodeUnknownSync(ChatSnapshot)({
      activity: { children: [], compactions: [], reminders, tasks: [] },
      address: {
        agentId: "agent",
        conversationId: "chat",
        organizationId: "organization",
        sessionId: "first",
      },
      agentVersion: 1,
      approvals: [],
      busy: false,
      messages: [],
      queuedInputs: [],
      tools: [],
    });
    assert.ok(jsonBytes(snapshot) < 256_000);
    const worstIdentifiers = reminders.map((reminder) => ({
      ...reminder,
      id: `reminder:${"\u0000".repeat(512)}`,
    }));
    assert.ok(
      jsonBytes({
        ...snapshot,
        activity: { ...snapshot.activity, reminders: worstIdentifiers },
      }) < 1_048_576
    );
    assert.equal(fixture.jobs.list().length, 100);
    await Promise.all(
      fixture.jobs.list().map((job) => fixture.jobs.cancel(job.id))
    );
    assert.equal(fixture.jobs.list().length, 0);
    await fixture.reopen();
    assert.equal(fixture.jobs.list().length, 100);
    assert.deepEqual(
      fixture.jobs
        .list()
        .map(
          (job) =>
            Schema.decodeUnknownSync(ReminderPayload)(job.payload).reminderId
        )
        .toSorted(),
      Array.from(
        { length: 100 },
        (_, index) => `reminder:active-${index}`
      ).toSorted()
    );
    const [job] = fixture.jobs.list();
    assert.ok(job);
    const payload = Schema.decodeUnknownSync(ReminderPayload)(job.payload);
    assert.equal(payload.input.instruction.length, 32_000);
    fixture.setTime(runAt);
    await fixture.reminders().deliver("reminder:active-0", runAt);
    await fixture.submissions();
    const transcript = await fixture.transcript();
    const input = transcript.messages.find(
      (message) => message.role === "user"
    );
    assert.equal(
      input?.content,
      `Scheduled instruction (reminder:active-0, 2026-10-21T12:01:00.000Z):\n${fullInstruction}`
    );
  } finally {
    await fixture.close();
  }
});

test("direct and model scheduling reject recurrence intervals outside the public chat contract", async () => {
  const fixture = await setup();
  try {
    const recurrence = {
      interval: 1001,
      timezone: "UTC",
      unit: "minute" as const,
    };
    await assert.rejects(
      fixture.reminders().schedule(
        {
          instruction: "Invalid interval",
          recurrence,
          runAt: fixture.now() + 60_000,
        },
        "invalid-interval"
      ),
      InvalidInput
    );
    assert.deepEqual(await fixture.reminders().list(), []);
    assert.equal(fixture.jobs.list().length, 0);
    const result = await fixture.invokeTool("schedule", {
      delaySeconds: 60,
      instruction: "Invalid interval",
      recurrence,
    });
    assert.equal(result.status, "done");
    const transcript = await fixture.transcript();
    const rejected = transcript.messages.find(
      (message) => message.role === "toolResult"
    );
    assert.equal(rejected?.role, "toolResult");
    if (rejected?.role === "toolResult") {
      assert.equal(rejected.isError, true);
    }
    assert.deepEqual(await fixture.reminders().list(), []);
    assert.equal(fixture.jobs.list().length, 0);
    await fixture.invokeTool("schedule", {
      delaySeconds: 60,
      instruction: "Valid maximum interval",
      recurrence: { ...recurrence, interval: 1000 },
    });
    const reminders = await fixture.reminders().list();
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0]?.recurrence?.interval, 1000);
    assert.deepEqual(
      Schema.decodeUnknownSync(ChatReminder)(reminders[0]),
      reminders[0]
    );
    assert.equal(fixture.jobs.list().length, 1);
  } finally {
    await fixture.close();
  }
});
