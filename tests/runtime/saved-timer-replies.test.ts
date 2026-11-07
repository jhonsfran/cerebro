import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { id } from "../../packages/contracts/src/identity.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import { triggerId } from "../../packages/contracts/src/triggers.ts";
import type { TriggerAdmissionInput } from "../../packages/contracts/src/triggers.ts";
import { TeamReportDeliverySchema } from "../../packages/contracts/src/work.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { ReminderOrigins } from "../../packages/runtime/src/saved-timer-state.ts";
import { submitSavedTimer } from "../../packages/runtime/src/saved-timer-submit.ts";
import { context } from "./coordinator-fixture.ts";
import { replyCall, setupReplies } from "./coordinator-reply-fixture.ts";
import { actor } from "./coordinator-web-fixture.ts";

const admittedId = (input: TriggerAdmissionInput) =>
  "trigger" in input ? input.trigger.id : input.id;

test("timers and their Team reports keep the creating Slack thread after unrelated web input, and child timers inherit it", async () => {
  const subject = await setupReplies(true);
  try {
    const origin = await subject.trigger(
      "original-timer-thread",
      "Schedule the independent review."
    );
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("schedule", {
          instruction:
            "Ask a private team to inspect storage, then schedule a follow-up.",
          delaySeconds: 60,
        }),
        { stopReason: "toolUse" }
      ),
      replyCall(origin.id, "The original Slack timer is saved."),
      fauxAssistantMessage("Saved."),
      fauxAssistantMessage(
        "This unrelated answer stays in the primary web chat."
      ),
    ]);
    await subject.admit(origin);
    await subject.replied(origin.id);
    await subject.settled(origin.id);
    const [timer] = await subject.scope.reminders.list();
    assert.ok(timer);
    const originRecord = await subject.fixture
      .pi()
      .snapshot(ReminderOrigins, subject.source.native.id, timer.id, context);
    assert.deepEqual(originRecord?.record, {
      creatingEventId: origin.id,
      reply: origin.reply,
    });
    const web = await subject.send(
      "unrelated-before-timer",
      "Answer a separate web question."
    );
    assert.equal(web.status, 200);
    await subject.settled(
      await triggerId(subject.source.address, {
        kind: "web",
        operationId: id.operation("unrelated-before-timer"),
      })
    );
    assert.equal(subject.posted.length, 1);
    let timerId: string | undefined;
    const timerProfile = { runtime: subject.scope.runtime };
    const occurrence = {
      reminderId: timer.id,
      fingerprint: JSON.stringify([timer.instruction, timer.runAt, null]),
      occurrence: timer.runAt,
      instruction: timer.instruction,
    };
    const scheduleId = `saved-timer:${await digestToolArguments([subject.source.address, timer.id])}`;
    const expectedTimerId = await triggerId(subject.source.address, {
      kind: "timer",
      scheduleId,
      occurrenceId: String(timer.runAt),
    });
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "start_team",
            { goal: "Inspect the saved timer's storage choice." },
            { id: "timer-team" }
          ),
          fauxToolCall(
            "schedule",
            {
              instruction: "Follow up on this same Slack request.",
              delaySeconds: 120,
            },
            { id: "child-timer" }
          ),
        ],
        { stopReason: "toolUse" }
      ),
      replyCall(expectedTimerId, "The timer started its team."),
      fauxAssistantMessage("Timer handled."),
    ]);
    const { triggers } = subject;
    await submitSavedTimer({
      pi: subject.fixture.pi(),
      nativeId: subject.source.native.id,
      current: () => timerProfile,
      occurrence,
      triggers: {
        read: (...args) => triggers.read(...args),
        admit: async (...args) => {
          timerId = admittedId(args[0]);
          return await triggers.admit(...args);
        },
      },
    });
    assert.equal(timerId, expectedTimerId);
    const timerReceipt = await subject.fixture.receipt(expectedTimerId);
    assert.equal(timerReceipt.trigger.origin.kind, "timer");
    assert.deepEqual(timerReceipt.trigger.reply, origin.reply);
    const reply = await subject.replied(expectedTimerId);
    assert.equal(reply.destination.authority.eventId, "original-timer-thread");
    await subject.settled(expectedTimerId);
    assert.equal(subject.posted.length, 2);
    await subject.fixture.waitDispatch();
    const work = await subject.fixture.work("a");
    assert.equal(work.humanOperationId, expectedTimerId);
    const reminders = await subject.scope.reminders.list();
    const child = reminders.find((row) => row.id !== timer.id);
    assert.ok(child);
    const childOrigin = await subject.fixture
      .pi()
      .snapshot(ReminderOrigins, subject.source.native.id, child.id, context);
    assert.equal(childOrigin?.record?.creatingEventId, expectedTimerId);
    assert.deepEqual(childOrigin?.record?.reply, origin.reply);
    const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema)({
      version: 2,
      sourceEventAddress: subject.source.address,
      report: {
        id: "report:timer-team",
        key: work.admission.key,
        kind: "completed",
        text: "SQLite is suitable.",
        contentDependencies: { sourceIds: [], toolIds: [] },
      },
    });
    const reportId = await triggerId(subject.source.address, {
      kind: "teamreport",
      key: work.admission.key,
      reportId: delivery.report.id,
      outcome: "completed",
    });
    subject.source.faux.setResponses([
      replyCall(reportId, "The private team recommends SQLite."),
      fauxAssistantMessage("Reported."),
    ]);
    const response = await subject.scope.handle(
      new Request("https://session.internal/team-report", {
        method: "POST",
        body: JSON.stringify(delivery),
      }),
      actor
    );
    assert.equal(response.status, 200, await response.clone().text());
    const result = await subject.replied(reportId);
    assert.equal(result.destination.authority.eventId, "original-timer-thread");
    assert.equal(subject.posted.length, 3);
    assert.equal(
      subject.posted[2]?.text,
      "The private team recommends SQLite."
    );
    assert.ok(
      subject.posted.every((row) => row.threadTs === "1800000000.000001")
    );
    await subject.triggers.admit(timerReceipt.trigger, actor);
    assert.equal(subject.posted.length, 3);
  } finally {
    await subject.close();
  }
});
