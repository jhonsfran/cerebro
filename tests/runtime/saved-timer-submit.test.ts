import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Schema } from "effect";

import { Conflict, Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { LegacyTimerReplyOriginSchema } from "../../packages/contracts/src/timer-events.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
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
import { createSourceAdmission } from "../../packages/runtime/src/source-admission.ts";
import { context, setup } from "./coordinator-fixture.ts";
import { actor } from "./coordinator-web-fixture.ts";

const setupTimer = async () => {
  const fixture = await setup(600_000, false, {
    b: "coordinator-A",
    c: "coordinator-A",
  });
  const original = fixture.source("b");
  const primary = fixture.source("a");
  const legacy = Schema.decodeUnknownSync(LegacyTimerReplyOriginSchema)({
    kind: "legacy-slack-timer",
    source: original.address,
    ownerPrincipalId: actor.actor.id,
    authority: { appId: "app-A", userId: "slack-A", thread: original.thread },
  });
  let denied = false;
  let linked = true;
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
        primaryAddress: primary.address,
        legacyTimerOrigin: legacy,
        ownerContext: () => Effect.succeed(actor),
        contentDependencies: () => Promise.resolve(dependencies),
        checkDependencies: () =>
          denied
            ? Effect.fail(
                new Denied({ code: "revoked", reason: "Content revoked." })
              )
            : Effect.void,
        eventReplies: {
          destination: (origin: unknown) => {
            assert.deepEqual(origin, legacy);
            return Promise.resolve(legacy);
          },
          authorize: () =>
            linked
              ? Promise.resolve()
              : Promise.reject(
                  new Denied({ code: "revoked", reason: "Link revoked." })
                ),
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
            throw new Error("Lost primary event response.");
          }
          return receipt;
        },
      },
    });
  const source = () =>
    createSourceAdmission({
      pi: fixture.pi(),
      nativeId: fixture.source("b").native.id,
      address: original.address,
      primary: primary.address,
      busy: () => false,
      jobs: fixture.lifecycleJobs,
      persist: () => Promise.resolve(),
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
          new Error("Forwarding must not submit a new old-native input.")
        ),
      submitOccurrence: submit,
      now: () => clock,
      saveOriginIn: (tx, reminderId) =>
        saveReminderOriginIn(tx, {
          nativeId: original.native.id,
          reminderId,
          address: original.address,
          ownerPrincipalId: actor.actor.id,
          legacy,
        }),
      ...extra,
    });
  return {
    fixture,
    original,
    primary,
    legacy,
    admitted,
    source,
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
    unlink: () => {
      linked = false;
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

test("retained source timers forward full instructions once to the same agent primary, with immutable dependencies and original destination", async () => {
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
    assert.equal(payload.input.instruction.length, 32_000);
    await subject.source().restore();
    subject.setTime(input.runAt);
    assert.ok(await subject.reminders().deliver(timer.id, input.runAt));
    assert.equal(subject.admitted.length, 0);
    await subject.source().advance();
    subject.lose();
    assert.ok(await subject.reminders().deliver(timer.id, input.runAt));
    const first = await subject.record();
    assert.deepEqual(first.source, subject.original.address);
    assert.deepEqual(first.event.coordinator, subject.primary.address);
    assert.equal(first.event.content.text, input.instruction);
    assert.deepEqual(first.event.dependencies, {
      sourceIds: [id.source("original-content")],
      toolIds: ["original-tool"],
    });
    assert.deepEqual(first.destination, subject.legacy);
    assert.deepEqual(first.replyOrigin, subject.legacy);
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
    const savedResult1 = await subject.reminders().list();
    const [advanced] = savedResult1;
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
    const savedResult2 = await subject.reminders().list();
    assert.equal(savedResult2[0]?.state, "cancelled");
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
      reply: subject.legacy,
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
      Schema.decodeUnknownSync(ReminderPayload)(armed.payload).input
        .instruction,
      input.instruction
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
          legacy: subject.legacy,
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
    const savedResult3 = await subject.reminders().list();
    assert.equal(savedResult3.length, 1);
    assert.equal(subject.admitted.length, 0);
  } finally {
    jobs.push = push;
    await subject.close();
  }
});

test("a saved timer occurrence never replaces its payload, owner, or current source and link checks", async () => {
  const subject = await setupTimer();
  try {
    await subject.source().restore();
    await subject.source().advance();
    const occurrence = {
      reminderId: "reminder:fixed",
      fingerprint: "fixed-fingerprint",
      instruction: "Use the original input.",
      occurrence: subject.now(),
    };
    subject.lose();
    await assert.rejects(subject.submit(occurrence), /Lost primary/u);
    await assert.rejects(
      subject.submit({ ...occurrence, instruction: "Changed input." }),
      Conflict
    );
    subject.unlink();
    await assert.rejects(subject.submit(occurrence), Denied);
    assert.equal(subject.admitted.length, 1);
    subject.deny();
    await assert.rejects(subject.submit(occurrence), Denied);
    assert.equal(subject.admitted.length, 1);
  } finally {
    await subject.close();
  }
});

for (const phase of ["queued", "placed", "done"] as const) {
  test(`an original ${phase} timer input advances the retained occurrence without a second primary event after a crash gap`, async () => {
    const subject = await setupTimer();
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    try {
      const { native } = subject.original;
      subject.original.faux.setResponses([
        async () => {
          entered.resolve(true);
          await release.promise;
          return fauxAssistantMessage("The original accepted input completed.");
        },
        fauxAssistantMessage("The old queued timer completed."),
      ]);
      const runAt = subject.now() + 1000;
      const input = { instruction: `Retained ${phase} instruction.`, runAt };
      const timer = await subject.reminders().schedule(input, `old-${phase}`);
      const oldText = `Scheduled instruction (${timer.id}, ${new Date(runAt).toISOString()}):\n${input.instruction}`;
      const first =
        phase === "queued"
          ? await native.submit(
              {
                type: "input",
                requestId: "prior-running",
                content: "Other accepted work.",
              },
              context
            )
          : undefined;
      if (first) {
        await entered.promise;
      }
      const old = await native.submit(
        { type: "input", requestId: `${timer.id}:${runAt}`, content: oldText },
        context
      );
      if (phase !== "queued") {
        await entered.promise;
      }
      if (phase === "done") {
        release.resolve(true);
        await old.wait(context);
      }
      const savedResult4 = await old.status(context);
      assert.equal(savedResult4.status, phase === "placed" ? "placed" : phase);
      await subject.source().restore();
      subject.setTime(runAt);
      await subject.reminders().deliver(timer.id, runAt);
      assert.equal(subject.admitted.length, 0);
      const savedResult5 = await subject.reminders().list();
      assert.equal(savedResult5[0]?.state, "completed");
      release.resolve(true);
      await old.wait(context);
      if (first) {
        await first.wait(context);
      }
      assert.equal(
        subject.original.faux.state.callCount,
        phase === "queued" ? 2 : 1
      );
      await subject.source().advance();
      const savedResult6 = await subject.source().read();
      assert.equal(savedResult6.kind, "archived");
      await subject.reminders().deliver(timer.id, runAt);
      assert.equal(subject.admitted.length, 0);
      assert.equal(subject.primary.faux.state.callCount, 0);
    } finally {
      release.resolve(true);
      await subject.close();
    }
  });
}

test("old timer request IDs with changed retained text fail closed instead of creating a primary event", async () => {
  const subject = await setupTimer();
  try {
    const occurrence = {
      reminderId: "reminder:collision",
      fingerprint: "fingerprint",
      instruction: "Original instruction.",
      occurrence: subject.now(),
    };
    const accepted = await subject.original.native.submit(
      {
        type: "input",
        requestId: `${occurrence.reminderId}:${occurrence.occurrence}`,
        content: "A different old native input.",
      },
      context
    );
    await accepted.wait(context);
    await subject.source().restore();
    await subject.source().advance();
    await assert.rejects(subject.submit(occurrence), Conflict);
    assert.equal(subject.admitted.length, 0);
  } finally {
    await subject.close();
  }
});

test("identical reminder IDs from distinct original sessions have distinct primary event identities", async () => {
  const subject = await setupTimer();
  try {
    const occurrence = {
      reminderId: "reminder:shared",
      fingerprint: "fingerprint",
      instruction: "An independent retained timer.",
      occurrence: subject.now(),
    };
    await subject.source().restore();
    await subject.source().advance();
    await subject.submit(occurrence);
    const first = await subject.record();
    const sibling = subject.fixture.source("c");
    const siblingProfile = {
      runtime: {
        ...subject.profile.runtime,
        configuration: {
          ...subject.profile.runtime.configuration,
          address: sibling.address,
          legacyTimerOrigin: undefined,
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
