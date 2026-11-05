import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import type { BotEvent } from "../../packages/contracts/src/bot-events.ts";
import { botEventId } from "../../packages/contracts/src/bot-events.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { TeamReportDeliverySchema } from "../../packages/contracts/src/work.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { coordinatorReportEvent } from "../../packages/runtime/src/coordinator-event-content.ts";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import {
  ReminderOrigins,
  TimerOccurrences,
} from "../../packages/runtime/src/saved-timer-state.ts";
import { submitSavedTimer } from "../../packages/runtime/src/saved-timer-submit.ts";
import { context } from "./coordinator-fixture.ts";
import { setupReplies } from "./coordinator-reply-fixture.ts";
import { actor } from "./coordinator-web-fixture.ts";

test("timers and their private Team reports keep the creating Slack origin after unrelated web input and save direct origins for child timers", async () => {
  const subject = await setupReplies(true, true);
  try {
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("schedule", {
          instruction:
            "Ask a private team to inspect storage, then schedule a follow-up.",
          delaySeconds: 60,
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("The original Slack timer is saved."),
      fauxAssistantMessage(
        "This unrelated answer stays in the primary web chat."
      ),
    ]);
    const origin = await subject.event(
      "original-timer-thread",
      "Schedule the independent review."
    );
    await subject.admit(origin);
    await subject.settled(origin);
    const [timer] = await subject.scope.reminders.list();
    assert.ok(timer);
    const originRecord = await subject.fixture
      .pi()
      .snapshot(ReminderOrigins, subject.source.native.id, timer.id, context);
    assert.deepEqual(originRecord?.record, {
      creatingEventId: origin.id,
      reply: {
        kind: "slack-event",
        source: subject.source.address,
        ownerPrincipalId: actor.actor.id,
        eventId: origin.id,
      },
    });
    const savedResult1 = await subject.send(
      "unrelated-before-timer",
      "Answer a separate web question."
    );
    assert.equal(savedResult1.status, 200);
    const webId = await botEventId(subject.source.address, {
      kind: "web",
      operationId: id.operation("unrelated-before-timer"),
    });
    const web = await subject.fixture
      .pi()
      .snapshot(BotEventReceipts, webId, context);
    assert.ok(web?.receipt?.delivery.kind === "coordinator");
    await subject.fixture
      .pi()
      .waitForTask(web.receipt.delivery.taskId, context);
    assert.equal(subject.posted.length, 1);
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
      fauxAssistantMessage(
        "The timer started its private team and saved a follow-up."
      ),
    ]);
    let timerEvent: BotEvent | undefined;
    const { events } = subject;
    const timerProfile = { runtime: subject.scope.runtime };
    await submitSavedTimer({
      pi: subject.fixture.pi(),
      nativeId: subject.source.native.id,
      current: () => timerProfile,
      occurrence: {
        reminderId: timer.id,
        fingerprint: JSON.stringify([timer.instruction, timer.runAt, null]),
        occurrence: timer.runAt,
        instruction: timer.instruction,
      },
      events: {
        ...events,
        admit: async (...args) => {
          [timerEvent] = args;
          return await events.admit(...args);
        },
      },
    });
    assert.ok(timerEvent);
    const reply = await subject.settled(timerEvent);
    assert.equal(reply.destination?.authority.eventId, "original-timer-thread");
    assert.equal(subject.posted.length, 2);
    await subject.fixture.waitDispatch();
    const work = await subject.fixture.work("a");
    assert.equal(work.humanOperationId, timerEvent.id);
    const savedResult2 = await subject.scope.reminders.list();
    const child = savedResult2.find((row) => row.id !== timer.id);
    assert.ok(child);
    const childOrigin = await subject.fixture
      .pi()
      .snapshot(ReminderOrigins, subject.source.native.id, child.id, context);
    assert.equal(childOrigin?.record?.creatingEventId, timerEvent.id);
    assert.deepEqual(childOrigin?.record?.reply, originRecord?.record?.reply);
    const occurrence = await subject.fixture
      .pi()
      .snapshot(TimerOccurrences, timerEvent.id, context);
    assert.equal(
      occurrence?.record?.destination?.authority.eventId,
      "original-timer-thread"
    );
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        "The private team recommends SQLite for this original request."
      ),
    ]);
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
    const response = await subject.scope.handle(
      new Request("https://session.internal/team-report", {
        method: "POST",
        body: JSON.stringify(delivery),
      }),
      actor
    );
    assert.equal(response.status, 200, await response.clone().text());
    const reportEvent = await coordinatorReportEvent(work, delivery.report);
    const result = await subject.settled(reportEvent);
    assert.equal(
      result.destination?.authority.eventId,
      "original-timer-thread"
    );
    assert.equal(subject.posted.length, 3);
    assert.equal(
      subject.posted[2]?.text,
      "The private team recommends SQLite for this original request."
    );
    assert.ok(
      subject.posted.every((row) => row.threadTs === "1800000000.000001")
    );
    await subject.events.admit(timerEvent, actor);
    await subject.settled(timerEvent);
    assert.equal(subject.posted.length, 3);
  } finally {
    await subject.close();
  }
});
