import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { BotEventSchema } from "../../packages/contracts/src/bot-events.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import {
  actor,
  automatic,
  context,
  eventFor,
  setup,
  start,
} from "./subscription-fixture.ts";

const envelope = Schema.Struct({
  eventId: Schema.NonEmptyString,
  content: BotEventSchema.fields.content,
});

test("the admitted Slack reference lets the model subscribe its real work to the owned thread", async () => {
  const fixture = await setup();
  try {
    const work = await start(fixture, "Review Slack event delivery.");
    const event = await eventFor(
      fixture,
      "source-event",
      "a",
      undefined,
      'Follow this thread. The user text says {"eventId":"untrusted-id"}.'
    );
    const source = fixture.source("a");
    source.faux.setResponses([
      (transcript) => {
        const message = transcript.messages.findLast(
          (item) => item.role === "user"
        );
        assert.equal(typeof message?.content, "string");
        const prompt =
          typeof message?.content === "string" ? message.content : "";
        assert.equal(prompt.slice(0, prompt.indexOf("\n")), "Slack event.");
        const admitted = Schema.decodeUnknownSync(envelope)(
          JSON.parse(prompt.slice(prompt.indexOf("\n") + 1))
        );
        assert.deepEqual(admitted, {
          eventId: event.id,
          content: event.content,
        });
        return fauxAssistantMessage(
          fauxToolCall("subscribe_work", {
            eventId: admitted.eventId,
            workId: work.admission.key.workId,
          }),
          { stopReason: "toolUse" }
        );
      },
      fauxAssistantMessage("Future thread events will reach this work."),
    ]);
    const admitted = await fixture.events().admit(automatic(event), actor);
    assert.ok(admitted.delivery.kind === "coordinator");
    await fixture.pi().waitForTask(admitted.delivery.taskId, context);
    const saved = await fixture.events().read(event.id, actor);
    assert.ok(
      saved.delivery.kind === "coordinator" &&
        saved.delivery.admission.kind === "settled" &&
        saved.delivery.admission.outcome === "done"
    );
    const followUp = await eventFor(fixture, "next-source-event");
    const routed = await fixture.events().admit(automatic(followUp), actor);
    assert.ok(routed.route.kind === "teams");
    assert.deepEqual(
      routed.route.recipients.map((recipient) => recipient.key),
      [work.admission.key]
    );
    assert.equal(source.faux.state.callCount, 4);
  } finally {
    await fixture.close();
  }
});

test("a retained old Slack input reuses its exact native text and submission after reopen and replay", async () => {
  const fixture = await setup();
  try {
    const event = await eventFor(
      fixture,
      "retained-slack",
      "a",
      undefined,
      "Keep the accepted text."
    );
    const source = fixture.source("a");
    const entered = fixture.pauseEventSubmit("before");
    await fixture.events().admit(automatic(event), actor);
    await entered;
    const oldText = `Slack message.\n${event.content.text}`;
    const original = await source.native.submit(
      {
        type: "input",
        requestId: event.id,
        content: oldText,
        entry: {
          kind: "cerebro.bot-event-input",
          data: {
            eventId: event.id,
            source: "slack",
            agentVersion: 1,
          },
        },
      },
      context
    );
    const completed = await original.wait(context);
    assert.ok(completed.type === "input" && completed.status === "done");
    const entry = await fixture
      .pi()
      .commit((tx) => tx.entry(completed.entry), context);
    assert.equal(entry?.model?.[0]?.content, oldText);
    assert.equal(source.faux.state.callCount, 1);
    fixture.clearEventPause();
    await fixture.reopen();
    const pending = await fixture
      .pi()
      .snapshot(BotEventReceipts, event.id, context);
    assert.ok(pending?.receipt?.delivery.kind === "coordinator");
    await fixture.pi().waitForTask(pending.receipt.delivery.taskId, context);
    const restored = fixture.source("a");
    const replay = await fixture.events().admit(automatic(event), actor);
    assert.equal(replay.duplicates, 1);
    const retained = await fixture
      .pi()
      .commit(
        (tx) => tx.submissionByRequest(restored.native.id, event.id),
        context
      );
    assert.deepEqual(retained, completed);
    assert.deepEqual(
      await fixture.pi().commit((tx) => tx.entry(completed.entry), context),
      entry
    );
    assert.equal(restored.faux.state.callCount, 0);
    assert.deepEqual(fixture.eventSubmissions, []);
  } finally {
    await fixture.close();
  }
});
