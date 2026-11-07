/* oxlint-disable unicorn/no-await-expression-member, no-await-in-loop -- Each persisted observation and crash boundary depends on its preceding result. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import type {
  ChatActivity,
  ChatSnapshot,
} from "../../packages/contracts/src/session-service.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import { triggerId } from "../../packages/contracts/src/triggers.ts";
import {
  addressFor,
  boot,
  capabilityProvider,
  capabilityStorage,
  chatControl,
  compose,
  control,
  evidence,
  lifecycle,
  newStack,
  provider,
  rawRequest,
  read,
  request,
  send,
  stop,
  waitFor,
} from "./helpers.ts";
import type { Stack } from "./helpers.ts";

let stack: Stack;
let failed = false;
const activity = (snapshot: ChatSnapshot): ChatActivity => {
  assert.ok(snapshot.activity);
  return snapshot.activity;
};
const settled = (snapshot: ChatSnapshot): boolean =>
  !snapshot.busy &&
  snapshot.messages.some((message) => message.role === "assistant");
const userTexts = (snapshot: ChatSnapshot): readonly string[] =>
  snapshot.messages
    .filter((message) => message.role === "user")
    .map((message) => message.text);
const occurrenceRequestId = async (
  address: EventAddress,
  reminderId: string,
  occurrence: number
): Promise<string> =>
  triggerId(address, {
    kind: "timer",
    occurrenceId: String(occurrence),
    scheduleId: `saved-timer:${await digestToolArguments([address, reminderId])}`,
  });
const note = async (
  address: EventAddress,
  operationId: string,
  text: string
) => {
  await send(stack, address, operationId, text);
  return waitFor(
    () => read(stack, address),
    (snapshot) => settled(snapshot) && userTexts(snapshot).includes(text)
  );
};
const restart = () => {
  compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
  compose(stack, ["up", "-d", "--wait", "celld"]);
};
before(
  async () => {
    stack = await newStack("capabilities");
    boot(stack);
  },
  { timeout: 600_000 }
);
after(
  async () => {
    if (failed) {
      await evidence(stack, "capabilities-failure", {
        logs: compose(stack, [
          "logs",
          "--no-color",
          "--tail=150",
          "celld",
          "bootstrap",
        ]),
        model: await capabilityProvider(stack),
        provider: await provider(stack),
      });
    }
    compose(stack, ["down", "-v"]);
  },
  { timeout: 120_000 }
);
const journey = (name: string, run: () => Promise<void>) =>
  test(name, { timeout: 180_000 }, async () => {
    try {
      await control(stack, {
        arm: null,
        delayMs: 0,
        failFirst: false,
        release: true,
      });
      await run();
    } catch (error) {
      failed = true;
      throw error;
    }
  });

journey(
  "one-shot reminders survive Stop and SIGKILL and admit one input before any reader",
  async () => {
    const address = addressFor("cap-reminder", "once", "cap-reminder-agent");
    const runAt = Date.now() + 6000;
    const command = {
      instruction: "CAP_REMINDER_DUE ONCE_MARKER",
      kind: "schedule" as const,
      operationId: "reminder-once",
      runAt,
    };
    const receipt = await chatControl(stack, address, command);
    assert.deepEqual(await chatControl(stack, address, command), receipt);
    const changed = await rawRequest(stack, "/runtime/control", {
      address,
      command: { ...command, instruction: "Changed reminder" },
    });
    assert.equal(changed.status, 409);
    await stop(stack, address);
    assert.ok(
      activity(await read(stack, address)).reminders.some(
        (value) => value.id === receipt.id && value.state === "scheduled"
      )
    );
    const armed = await lifecycle(stack, address);
    assert.ok(armed.jobs.some((job) => job.fn === "cerebro-reminder"));
    restart();
    const automatic = await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.scope === address.sessionId &&
            call.prompt.includes("ONCE_MARKER") &&
            call.completedAt !== undefined
        )
    );
    const final = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        settled(snapshot) &&
        activity(snapshot).reminders.some(
          (value) => value.id === receipt.id && value.state === "completed"
        )
    );
    const stored = await capabilityStorage(stack, address);
    const requestId = await occurrenceRequestId(address, receipt.id, runAt);
    assert.deepEqual(
      stored.submissions.map((submission) => [
        submission.requestId,
        submission.status,
      ]),
      [[requestId, "done"]]
    );
    assert.deepEqual(
      (await capabilityProvider(stack)).model
        .filter(
          (call) =>
            call.scope === address.sessionId && call.completedAt !== undefined
        )
        .map((call) => [call.purpose, call.prompt]),
      [
        [
          "turn",
          `Saved authorized instruction (eventId ${requestId}).\nCAP_REMINDER_DUE ONCE_MARKER`,
        ],
      ]
    );
    assert.deepEqual(
      final.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text),
      ["CAP_ACK"]
    );
    assert.deepEqual(await chatControl(stack, address, command), receipt);
    assert.equal(
      activity(await read(stack, address)).reminders.find(
        (value) => value.id === receipt.id
      )?.state,
      "completed"
    );
    await evidence(stack, "capability-reminder-recovery", {
      armed,
      automatic,
      final,
      receipt,
      stored,
    });
  }
);

journey(
  "recurring reminders advance without model rescheduling and cancellation survives restart",
  async () => {
    const address = addressFor(
      "cap-recurring",
      "recurring",
      "cap-recurring-agent"
    );
    const runAt = Date.now() + 2000;
    const receipt = await chatControl(stack, address, {
      instruction: "CAP_REMINDER_DUE RECURRING_MARKER",
      kind: "schedule",
      operationId: "recurring",
      recurrence: { interval: 1, timezone: "America/Bogota", unit: "minute" },
      runAt,
    });
    await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.scope === address.sessionId && call.completedAt !== undefined
        )
    );
    const first = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        settled(snapshot) &&
        activity(snapshot).reminders.some(
          (value) => value.id === receipt.id && value.runAt === runAt + 60_000
        )
    );
    restart();
    const automatic = await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.filter(
          (call) =>
            call.scope === address.sessionId && call.completedAt !== undefined
        ).length === 2,
      90_000
    );
    const second = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        settled(snapshot) &&
        activity(snapshot).reminders.some(
          (value) => value.id === receipt.id && value.runAt === runAt + 120_000
        )
    );
    const stored = await capabilityStorage(stack, address);
    assert.deepEqual(
      stored.submissions.map((submission) => [
        submission.requestId,
        submission.status,
      ]),
      [
        [await occurrenceRequestId(address, receipt.id, runAt), "done"],
        [
          await occurrenceRequestId(address, receipt.id, runAt + 60_000),
          "done",
        ],
      ]
    );
    await chatControl(stack, address, {
      kind: "cancel-schedule",
      scheduleId: receipt.id,
    });
    await chatControl(stack, address, {
      kind: "cancel-schedule",
      scheduleId: receipt.id,
    });
    restart();
    const cancelled = await read(stack, address);
    assert.equal(
      activity(cancelled).reminders.find((value) => value.id === receipt.id)
        ?.state,
      "cancelled"
    );
    assert.equal(
      (await lifecycle(stack, address)).jobs.some(
        (job) => job.fn === "cerebro-reminder"
      ),
      false
    );
    await evidence(stack, "capability-recurring-reminder", {
      automatic,
      cancelled,
      first,
      receipt,
      second,
      stored,
    });
  }
);

journey(
  "model tools register durable reminders that can be cancelled through the chat control",
  async () => {
    const address = addressFor(
      "cap-model-schedule",
      "scheduled",
      "cap-schedule-agent"
    );
    await send(stack, address, "model-schedule", "CAP_SCHEDULE a follow-up");
    const snapshot = await waitFor(
      () => read(stack, address),
      (value) => settled(value) && activity(value).reminders.length === 1
    );
    const [reminder] = activity(snapshot).reminders;
    assert.ok(reminder);
    assert.equal(reminder.instruction, "CAP_REMINDER_TOOL_DUE");
    assert.ok(
      snapshot.tools.some(
        (tool) => tool.toolName === "schedule" && tool.state === "succeeded"
      )
    );
    await chatControl(stack, address, {
      kind: "cancel-schedule",
      scheduleId: reminder.id,
    });
    assert.equal(
      activity(await read(stack, address)).reminders[0]?.state,
      "cancelled"
    );
  }
);

journey(
  "manual compaction has one durable receipt and completes after SIGKILL before a reader",
  async () => {
    const address = addressFor(
      "cap-compaction",
      "long-history",
      "cap-compact-agent"
    );
    for (let index = 0; index < 10; index += 1) {
      await note(
        address,
        `long-${index}`,
        `CAP_COMPACT turn-${index} ${"archive ".repeat(1800)}`
      );
    }
    await control(stack, { delayMs: 5000 });
    const command = {
      instructions: "Preserve the archive decisions.",
      kind: "compact" as const,
      operationId: "manual-compaction",
    };
    const receipt = await chatControl(stack, address, command);
    const inFlight = await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.scope === address.sessionId &&
            call.purpose === "compaction" &&
            call.completedAt === undefined
        )
    );
    const attempts = inFlight.model.filter(
      (call) =>
        call.scope === address.sessionId && call.purpose === "compaction"
    );
    assert.equal(attempts.length, 1);
    const [attempt] = attempts;
    assert.ok(attempt);
    const killedAt = Date.now();
    restart();
    await control(stack, { delayMs: 0 });
    const automatic = await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.scope === address.sessionId &&
            call.purpose === "compaction" &&
            call.operationId === attempt.operationId &&
            call.startedAt > killedAt &&
            call.completedAt !== undefined
        )
    );
    const final = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        !snapshot.busy &&
        activity(snapshot).compactions.length === 0 &&
        snapshot.messages.some((message) =>
          message.text.includes("Fixture compacted capability history.")
        )
    );
    assert.deepEqual(await chatControl(stack, address, command), receipt);
    const stored = await capabilityStorage(stack, address);
    assert.equal(
      stored.tasks.filter((task) => task.kind === "pi.compaction").length,
      1
    );
    const wakeId = `cerebro-compact:${address.sessionId}:${command.operationId}`;
    await waitFor(
      () => lifecycle(stack, address),
      (value) => !value.jobs.some((job) => job.id === wakeId)
    );
    const changed = await rawRequest(stack, "/runtime/control", {
      address,
      command: { ...command, instructions: "Changed compaction" },
    });
    assert.equal(changed.status, 409);
    assert.equal(
      (await lifecycle(stack, address)).jobs.some((job) => job.id === wakeId),
      false
    );
    await evidence(stack, "capability-compaction-recovery", {
      automatic,
      final,
      receipt,
      stored,
      inFlight,
      killedAt,
    });
  }
);

journey(
  "Stop aborts manual compaction and an operation retry cannot restart it",
  async () => {
    const address = addressFor(
      "cap-compaction-stop",
      "history",
      "cap-compact-stop-agent"
    );
    for (let index = 0; index < 10; index += 1) {
      await note(
        address,
        `stop-history-${index}`,
        `CAP_COMPACT stop-turn-${index} ${"archive ".repeat(1800)}`
      );
    }
    await control(stack, { delayMs: 5000 });
    const command = {
      instructions: "Preserve the decisions.",
      kind: "compact" as const,
      operationId: "stopped-compaction",
    };
    const receipt = await chatControl(stack, address, command);
    await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.scope === address.sessionId &&
            call.purpose === "compaction" &&
            call.completedAt === undefined
        )
    );
    const running = await read(stack, address);
    await evidence(stack, "capability-compaction-stop-running", {
      live: await request(
        stack,
        "/runtime/fixture/capabilities/compaction-state",
        {
          address,
        }
      ),
      model: await capabilityProvider(stack),
      running,
      stored: await capabilityStorage(stack, address),
    });
    assert.equal(running.busy, true);
    assert.ok(
      activity(running).compactions.some(
        (compaction) =>
          compaction.id === receipt.id && compaction.reason === "manual"
      )
    );
    assert.equal((await stop(stack, address)).stopped, true);
    const stopped = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        !snapshot.busy && activity(snapshot).compactions.length === 0
    );
    assert.equal(
      stopped.messages.some((message) => message.kind === "summary"),
      false
    );
    const stored = await capabilityStorage(stack, address);
    const tasks = stored.tasks.filter((task) => task.kind === "pi.compaction");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "terminal");
    await control(stack, { delayMs: 0 });
    assert.deepEqual(await chatControl(stack, address, command), receipt);
    const wakeId = `cerebro-compact:${address.sessionId}:${command.operationId}`;
    await waitFor(
      () => lifecycle(stack, address),
      (value) => !value.jobs.some((job) => job.id === wakeId)
    );
    restart();
    const restored = await read(stack, address);
    assert.equal(restored.busy, false);
    assert.equal(activity(restored).compactions.length, 0);
    assert.equal(
      restored.messages.some((message) => message.kind === "summary"),
      false
    );
    assert.equal(
      (await capabilityStorage(stack, address)).tasks.filter(
        (task) => task.kind === "pi.compaction"
      ).length,
      1
    );
    const nextReceipt = await chatControl(stack, address, {
      ...command,
      operationId: "fresh-compaction",
    });
    assert.notEqual(nextReceipt.id, receipt.id);
    const completed = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        !snapshot.busy &&
        activity(snapshot).compactions.length === 0 &&
        snapshot.messages.some((message) => message.kind === "summary")
    );
    assert.equal(
      (await capabilityStorage(stack, address)).tasks.filter(
        (task) => task.kind === "pi.compaction"
      ).length,
      2
    );
    await evidence(stack, "capability-compaction-stop", {
      completed,
      nextReceipt,
      receipt,
      restored,
      running,
      stopped,
      stored,
    });
  }
);
