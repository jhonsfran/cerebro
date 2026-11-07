import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Schema } from "effect";

import { Conflict, Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  createConversationReminders,
  ReminderPayload,
} from "../../packages/runtime/src/conversation-reminders.ts";
import {
  BotEventReceipts,
  eventOf,
} from "../../packages/runtime/src/coordinator-event-state.ts";
import {
  ReminderOrigins,
  TimerOccurrences,
  saveReminderOriginIn,
} from "../../packages/runtime/src/saved-timer-state.ts";
import { submitSavedTimer } from "../../packages/runtime/src/saved-timer-submit.ts";
import { context, setup } from "./coordinator-fixture.ts";
import { actor } from "./coordinator-web-fixture.ts";

const setupTimer = async () => {
  const fixture = await setup(600_000, false, {
    b: "coordinator-A",
    c: "coordinator-A",
  });
  const original = fixture.source("b");
  let denied = false;
  let lose = false;
  let clock = Date.now();
  let dependencies = {
    sourceIds: [id.source("original-content")],
    toolIds: ["original-tool"],
  };
  const admitted: string[] = [];
  const profile = {
    runtime: {
      authorize: () =>
        denied
          ? Promise.reject(
              new Denied({ code: "revoked", reason: "The source was revoked." })
            )
          : Promise.resolve(),
      guardIn: () => Promise.resolve(),
      configuration: {
        address: original.address,
        ownerContext: () => Effect.succeed(actor),
        contentDependencies: () => Promise.resolve(dependencies),
        checkDependencies: () =>
          denied
            ? Effect.fail(
                new Denied({ code: "revoked", reason: "Content revoked." })
              )
            : Effect.void,
        eventReplies: {
          destination: () =>
            Promise.reject(new Error("Web timers have no Slack destination.")),
          authorize: () => Promise.resolve(),
          deliver: () => Promise.resolve(),
        },
      },
    },
  };
  const current = () => profile;
  const submit = (
    occurrence: Parameters<typeof submitSavedTimer>[0]["occurrence"]
  ) =>
    submitSavedTimer({
      pi: fixture.pi(),
      nativeId: fixture.source("b").native.id,
      current,
      occurrence,
      events: {
        ...fixture.events(),
        admit: async (...args) => {
          admitted.push(args[0].id);
          const receipt = await fixture.events().admit(...args);
          if (lose) {
            lose = false;
            throw new Error("Lost event response.");
          }
          return receipt;
        },
      },
    });
  const reminders = (
    extra: Partial<Parameters<typeof createConversationReminders>[0]> = {}
  ) =>
    createConversationReminders({
      pi: fixture.pi(),
      nativeId: fixture.source("b").native.id,
      sessionId: original.address.sessionId,
      jobs: fixture.lifecycleJobs,
      metadata: (operation) => fixture.pi().commit(operation, context),
      persist: () => Promise.resolve(),
      authorize: profile.runtime.authorize,
      submit: () =>
        Promise.reject(
          new Error("Timers must not submit a native input directly.")
        ),
      submitOccurrence: submit,
      now: () => clock,
      saveOriginIn: (tx, reminderId) =>
        saveReminderOriginIn(tx, {
          nativeId: original.native.id,
          reminderId,
          address: original.address,
          ownerPrincipalId: actor.actor.id,
        }),
      ...extra,
    });
  return {
    fixture,
    original,
    admitted,
    reminders,
    submit,
    profile,
    setTime: (value: number) => {
      clock = value;
    },
    now: () => clock,
    lose: () => {
      lose = true;
    },
    deny: () => {
      denied = true;
    },
    changeDependencies: () => {
      dependencies = {
        sourceIds: [id.source("later-content")],
        toolIds: ["later-tool"],
      };
    },
    record: async () => {
      const eventId = admitted.at(-1);
      assert.ok(eventId);
      const saved = await fixture
        .pi()
        .snapshot(TimerOccurrences, eventId, context);
      assert.ok(saved?.record);
      return saved.record;
    },
    close: fixture.close,
  };
};

test("saved timers forward full instructions once to their own conversation with immutable dependencies", async () => {
  const subject = await setupTimer();
  try {
    const input = {
      instruction: "x".repeat(32_000),
      runAt: subject.now() + 1000,
      recurrence: { unit: "minute" as const, interval: 1, timezone: "UTC" },
    };
    const timer = await subject.reminders().schedule(input, "r".repeat(512));
    const jobId = `cerebro-reminder:${subject.original.address.sessionId}:${timer.id}`;
    const before = subject.fixture.lifecycleJobs.get(jobId);
    assert.ok(before);
    const payload = Schema.decodeUnknownSync(ReminderPayload, {
      onExcessProperty: "error",
    })(before.payload);
    assert.equal(payload.reminderId.length, 521);
    assert.equal(payload.occurrence, input.runAt);
    subject.setTime(input.runAt);
    subject.lose();
    assert.ok(await subject.reminders().deliver(timer.id, input.runAt));
    const first = await subject.record();
    assert.deepEqual(first.source, subject.original.address);
    assert.deepEqual(first.event.coordinator, subject.original.address);
    assert.equal(first.event.content.text, input.instruction);
    assert.deepEqual(first.event.dependencies, {
      sourceIds: [id.source("original-content")],
      toolIds: ["original-tool"],
    });
    assert.equal(first.destination, null);
    assert.deepEqual(first.replyOrigin, { kind: "web" });
    subject.changeDependencies();
    await subject.fixture.reopen();
    const delivery = await subject.reminders().deliver(timer.id, input.runAt);
    assert.ok(delivery);
    assert.deepEqual(await subject.record(), first);
    assert.deepEqual(subject.admitted, [first.event.id, first.event.id]);
    const receipt = await subject.fixture
      .pi()
      .snapshot(BotEventReceipts, first.event.id, context);
    assert.ok(receipt?.receipt?.delivery.kind === "coordinator");
    await subject.fixture
      .pi()
      .waitForTask(receipt.receipt.delivery.taskId, context);
    const [advanced] = await subject.reminders().list();
    assert.ok(advanced);
    assert.equal(advanced.id, timer.id);
    assert.equal(advanced.lastDeliveredAt, input.runAt);
    assert.ok(advanced.runAt > input.runAt);
    const next = subject.fixture.lifecycleJobs.get(jobId);
    assert.ok(next);
    assert.equal(
      Schema.decodeUnknownSync(ReminderPayload)(next.payload).occurrence,
      advanced.runAt
    );
    await subject.reminders().cancel(timer.id);
    assert.equal(subject.fixture.lifecycleJobs.get(jobId), undefined);
    const [cancelled] = await subject.reminders().list();
    assert.equal(cancelled?.state, "cancelled");
  } finally {
    await subject.close();
  }
});

test("schedule and origin commit together before a timer arm can fail, and the generic wake restores the accepted schedule", async () => {
  const subject = await setupTimer();
  const jobs = subject.fixture.lifecycleJobs;
  const { push } = jobs;
  let rejectArm = true;
  try {
    jobs.push = async (input) => {
      if (input.fn === "cerebro-reminder" && rejectArm) {
        rejectArm = false;
        throw new Error("Crash before the actual timer arm.");
      }
      return await push(input);
    };
    const input = {
      instruction: "Keep the original destination.",
      runAt: subject.now() + 1000,
    };
    await assert.rejects(
      subject.reminders().schedule(input, "canonical-gap"),
      /actual timer arm/u
    );
    const [saved] = await subject.reminders().list();
    assert.ok(saved);
    assert.equal(saved.state, "scheduled");
    const origin = await subject.fixture
      .pi()
      .snapshot(ReminderOrigins, subject.original.native.id, saved.id, context);
    assert.deepEqual(origin?.record, {
      creatingEventId: null,
      reply: { kind: "web" },
    });
    assert.equal(
      jobs.get(
        `cerebro-reminder:${subject.original.address.sessionId}:${saved.id}`
      ),
      undefined
    );
    const wake = jobs.get(
      `cerebro-coordination:${subject.original.address.sessionId}`
    );
    assert.ok(wake);
    assert.deepEqual(wake.payload, {
      sessionId: subject.original.address.sessionId,
    });
    await subject.fixture.reopen();
    await subject.reminders().restore();
    const armed = jobs.get(
      `cerebro-reminder:${subject.original.address.sessionId}:${saved.id}`
    );
    assert.ok(armed);
    assert.equal(
      Schema.decodeUnknownSync(ReminderPayload)(armed.payload).reminderId,
      saved.id
    );
    assert.deepEqual(
      await subject.reminders().schedule(input, "canonical-gap"),
      saved
    );
    assert.equal(subject.admitted.length, 0);
  } finally {
    jobs.push = push;
    await subject.close();
  }
});

test("a raw generic wake that survives rollback cannot create a schedule or lose a reply origin", async () => {
  const subject = await setupTimer();
  try {
    const timers = subject.reminders({
      saveOriginIn: async (tx, reminderId) => {
        await saveReminderOriginIn(tx, {
          nativeId: subject.original.native.id,
          reminderId,
          address: subject.original.address,
          ownerPrincipalId: actor.actor.id,
        });
        throw new Error("Crash before canonical commit.");
      },
    });
    await assert.rejects(
      timers.schedule(
        {
          instruction: "Never execute rolled back input.",
          runAt: subject.now() + 1000,
        },
        "rollback"
      ),
      /canonical commit/u
    );
    assert.deepEqual(await timers.list(), []);
    const origin = await subject.fixture
      .pi()
      .snapshot(
        ReminderOrigins,
        subject.original.native.id,
        "reminder:rollback",
        context
      );
    assert.equal(origin?.record ?? null, null);
    const wake = subject.fixture.lifecycleJobs.get(
      `cerebro-coordination:${subject.original.address.sessionId}`
    );
    assert.ok(wake);
    assert.deepEqual(wake.payload, {
      sessionId: subject.original.address.sessionId,
    });
    await timers.restore();
    assert.equal(
      subject.fixture.lifecycleJobs
        .list()
        .filter((row) => row.fn === "cerebro-reminder").length,
      0
    );
    assert.equal(subject.admitted.length, 0);
    assert.equal(subject.original.faux.state.callCount, 0);
  } finally {
    await subject.close();
  }
});

test("a generic wake that starts before schedule commit reads the canonical schedule after that same Pi line", async () => {
  const subject = await setupTimer();
  const jobs = subject.fixture.lifecycleJobs;
  const { push } = jobs;
  let wake: Promise<void> | undefined;
  try {
    jobs.push = async (input) => {
      if (input.fn === "cerebro-coordination") {
        wake = subject.reminders().restore();
      }
      return await push(input);
    };
    const saved = await subject
      .reminders()
      .schedule(
        { instruction: "Survive the early wake.", runAt: subject.now() + 1000 },
        "early-wake"
      );
    assert.ok(wake);
    await wake;
    assert.ok(
      jobs.get(
        `cerebro-reminder:${subject.original.address.sessionId}:${saved.id}`
      )
    );
    const listed = await subject.reminders().list();
    assert.equal(listed.length, 1);
    assert.equal(subject.admitted.length, 0);
  } finally {
    jobs.push = push;
    await subject.close();
  }
});

test("a saved timer occurrence never replaces its payload, owner, or current source checks", async () => {
  const subject = await setupTimer();
  try {
    const occurrence = {
      reminderId: "reminder:fixed",
      fingerprint: "fixed-fingerprint",
      instruction: "Use the original input.",
      occurrence: subject.now(),
    };
    subject.lose();
    await assert.rejects(subject.submit(occurrence), /Lost event/u);
    await assert.rejects(
      subject.submit({ ...occurrence, instruction: "Changed input." }),
      Conflict
    );
    assert.equal(subject.admitted.length, 1);
    subject.deny();
    await assert.rejects(subject.submit(occurrence), Denied);
    assert.equal(subject.admitted.length, 1);
  } finally {
    await subject.close();
  }
});

test("identical reminder IDs from distinct sessions have distinct event identities", async () => {
  const subject = await setupTimer();
  try {
    const occurrence = {
      reminderId: "reminder:shared",
      fingerprint: "fingerprint",
      instruction: "An independent retained timer.",
      occurrence: subject.now(),
    };
    await subject.submit(occurrence);
    const first = await subject.record();
    const sibling = subject.fixture.source("c");
    const siblingProfile = {
      runtime: {
        ...subject.profile.runtime,
        configuration: {
          ...subject.profile.runtime.configuration,
          address: sibling.address,
        },
      },
    };
    let secondId: string | undefined;
    const events = subject.fixture.events();
    await submitSavedTimer({
      pi: subject.fixture.pi(),
      nativeId: sibling.native.id,
      events: {
        ...events,
        admit: async (...args) => {
          secondId = args[0].id;
          return await events.admit(...args);
        },
      },
      current: () => siblingProfile,
      occurrence,
    });
    assert.ok(secondId);
    assert.notEqual(secondId, first.event.id);
    const second = await subject.fixture
      .pi()
      .snapshot(TimerOccurrences, secondId, context);
    assert.deepEqual(second?.record?.source, sibling.address);
    const receipt = await subject.fixture
      .pi()
      .snapshot(BotEventReceipts, first.event.id, context);
    assert.ok(receipt?.receipt);
    assert.deepEqual(eventOf(receipt.receipt), first.event);
  } finally {
    await subject.close();
  }
});
