import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { botEventId } from "../../packages/contracts/src/bot-events.ts";
import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { toSlackText } from "../../packages/contracts/src/slack-text.ts";
import { TeamEventReturnSchema } from "../../packages/contracts/src/team-events.ts";
import { TeamReportDeliverySchema } from "../../packages/contracts/src/work.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { coordinatorReportEvent } from "../../packages/runtime/src/coordinator-event-content.ts";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import {
  CoordinatorReplies,
  conciseSlackText,
  createCoordinatorReplies,
} from "../../packages/runtime/src/coordinator-replies.ts";
import { context } from "./coordinator-fixture.ts";
import { setupReplies } from "./coordinator-reply-fixture.ts";
import { actor } from "./coordinator-web-fixture.ts";
import { waitFor } from "./helpers.ts";

test("a Slack tool turn replies to its exact answer while concurrent web input stays private to web", async () => {
  const subject = await setupReplies();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage(
          fauxToolCall("schedule", {
            instruction: "Review the saved result later.",
            delaySeconds: 60,
          }),
          { stopReason: "toolUse" }
        );
      },
      fauxAssistantMessage(
        "The Slack task is saved. This is the exact Slack answer."
      ),
      fauxAssistantMessage(
        "This unrelated web answer must never be sent to Slack."
      ),
      fauxAssistantMessage("The second thread receives only its own answer."),
    ]);
    const slack = await subject.event(
      "slack-tool",
      "Save a reminder, then answer this Slack event."
    );
    await subject.admit(slack);
    await entered.promise;
    const web = await subject.send(
      "web-concurrent",
      "Answer this unrelated web question."
    );
    assert.equal(web.status, 200, await web.clone().text());
    release.resolve(true);
    const reply = await subject.settled(slack);
    assert.equal(reply.delivery?.state, "sent");
    assert.equal(
      reply.text,
      "The Slack task is saved. This is the exact Slack answer."
    );
    const eventReceipt = await subject.fixture
      .pi()
      .snapshot(BotEventReceipts, slack.id, context);
    const delivery = eventReceipt?.receipt?.delivery;
    assert.ok(
      delivery?.kind === "coordinator" &&
        delivery.admission.kind === "settled" &&
        delivery.admission.outcome === "done"
    );
    assert.equal(reply.answerEntryId, delivery.admission.answer);
    const webId = await botEventId(subject.source.address, {
      kind: "web",
      operationId: id.operation("web-concurrent"),
    });
    const webReceipt = await subject.fixture
      .pi()
      .snapshot(BotEventReceipts, webId, context);
    assert.ok(webReceipt?.receipt?.delivery.kind === "coordinator");
    await subject.fixture
      .pi()
      .waitForTask(webReceipt.receipt.delivery.taskId, context);
    const webReply = await subject.fixture
      .pi()
      .snapshot(CoordinatorReplies, webId, context);
    assert.equal(webReply?.record, undefined);
    const second = await subject.event(
      "slack-second",
      "Answer the second thread.",
      "1800000001.000001"
    );
    await subject.admit(second);
    await subject.settled(second);
    assert.deepEqual(
      subject.posted.map((message) => ({
        text: message.text,
        thread: message.threadTs,
      })),
      [
        { text: reply.text, thread: "1800000000.000001" },
        {
          text: "The second thread receives only its own answer.",
          thread: "1800000001.000001",
        },
      ]
    );
    const count = subject.source.faux.state.callCount;
    await subject.admit(slack);
    await subject.settled(slack);
    assert.equal(subject.posted.length, 2);
    assert.equal(subject.source.faux.state.callCount, count);
    const snapshot = await subject.scope.read(actor);
    assert.deepEqual(
      snapshot.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["Answer this unrelated web question."]
    );
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("an exact Slack status saves a passive answer and delivery without a native submission or model", async () => {
  const subject = await setupReplies();
  try {
    const event = await subject.event("local-status", "status");
    const admitted = await subject.admit(event);
    assert.equal(admitted.route.kind, "local-answer");
    const reply = await subject.settled(event);
    assert.ok(admitted.route.kind === "local-answer");
    assert.equal(reply.answerEntryId, admitted.route.answerEntryId);
    assert.equal(subject.source.faux.state.callCount, 0);
    assert.equal(
      await subject.fixture
        .pi()
        .commit(
          (tx) => tx.submissionByRequest(subject.source.native.id, event.id),
          context
        ),
      undefined
    );
    assert.equal(subject.posted.length, 1);
    await subject.admit(event);
    assert.equal(subject.posted.length, 1);
  } finally {
    await subject.close();
  }
});

test("a local Slack status posts through admission retention without a test-created task waiter or product read", async () => {
  const subject = await setupReplies();
  try {
    const event = await subject.event("status-without-reader", "status");
    const admitted = await subject.admit(event);
    assert.equal(admitted.route.kind, "local-answer");
    assert.equal(admitted.delivery.kind, "none");
    assert.equal(subject.replyHoldCalls(), 1);
    const job = subject.fixture.lifecycleJobs.get(
      `cerebro-coordination:${subject.source.address.sessionId}`
    );
    assert.equal(job?.fn, "cerebro-coordination");
    await waitFor(
      () => subject.posted.length,
      (count) => count === 1
    );
    assert.equal(subject.source.faux.state.callCount, 0);
    const reply = await subject.fixture
      .pi()
      .snapshot(CoordinatorReplies, event.id, context);
    assert.equal(reply?.record?.delivery?.state, "sent");
    assert.equal(subject.posted[0]?.text, reply?.record?.text);
  } finally {
    await subject.close();
  }
});

test("the saved Slack projection converts Markdown, caps one huge word, and keeps the raw answer", async () => {
  const subject = await setupReplies();
  try {
    const raw = `# Result\n**Done** [details](https://example.com/result) ${"x".repeat(40_001)}`;
    subject.source.faux.setResponses([fauxAssistantMessage(raw)]);
    const event = await subject.event(
      "markdown-and-huge-word",
      "Give the exact result."
    );
    await subject.admit(event);
    const reply = await subject.settled(event);
    assert.equal(reply.text, toSlackText(raw));
    assert.equal(reply.text.length, 39_001);
    assert.match(
      reply.text,
      /^\*Result\*\n\*Done\* <https:\/\/example.com\/result\|details> /u
    );
    assert.ok([...reply.text.matchAll(/\S+/gu)].length <= 100);
    assert.equal(subject.posted[0]?.text, reply.text);
    const entry = await subject.fixture
      .pi()
      .commit((tx) => tx.entry(reply.answerEntryId), context);
    const [message] = entry?.model ?? [];
    assert.ok(message?.role === "assistant");
    const [block] = message.content;
    assert.ok(block?.type === "text");
    assert.equal(block.text, raw);
  } finally {
    await subject.close();
  }
});

test("reply projection keeps at most one hundred words and retains the complete answer in history", async () => {
  const subject = await setupReplies();
  try {
    const full = Array.from({ length: 150 }, (_, index) => `word${index}`).join(
      " \n"
    );
    subject.source.faux.setResponses([fauxAssistantMessage(full)]);
    const event = await subject.event("long-answer", "Give a full answer.");
    await subject.admit(event);
    const reply = await subject.settled(event);
    assert.equal(reply.text.split(/\s+/u).length, 100);
    assert.equal(reply.text, conciseSlackText(full));
    const snapshot = await subject.scope.read(actor);
    assert.ok(snapshot.messages.some((message) => message.text === full));
  } finally {
    await subject.close();
  }
});

for (const denial of ["link", "source", "content"] as const) {
  test(`current ${denial} denial saves a blocked reply outcome with no physical post`, async () => {
    const subject = await setupReplies();
    try {
      subject.source.faux.setResponses([
        () => {
          if (denial === "link") {
            subject.setLinked(false);
          }
          if (denial === "source") {
            subject.setRead(false);
          }
          if (denial === "content") {
            subject.setContent(false);
          }
          return fauxAssistantMessage("An answer that must stay undisclosed.");
        },
      ]);
      const event = await subject.event(
        `denied-${denial}`,
        "Prepare an answer."
      );
      await subject.admit(event);
      const reply = await subject.settled(event);
      assert.equal(reply.delivery?.state, "blocked");
      assert.equal(subject.posted.length, 0);
      assert.equal(subject.source.faux.state.callCount, 1);
    } finally {
      await subject.close();
    }
  });
}

test("the post boundary rechecks access after saving unknown and never repeats an uncertain post", async () => {
  const subject = await setupReplies();
  try {
    let checks = 0;
    subject.beforePost(() => {
      checks += 1;
      if (checks === 2) {
        subject.setLinked(false);
      }
      return Promise.resolve();
    });
    const blocked = await subject.event(
      "boundary-denial",
      "Answer before link changes."
    );
    await subject.admit(blocked);
    const blockedReply = await subject.settled(blocked);
    assert.equal(blockedReply.delivery?.state, "blocked");
    assert.equal(subject.posted.length, 0);
    subject.setLinked(true);
    subject.beforePost();
    subject.outcomes.push("unknown");
    subject.source.faux.setResponses([
      fauxAssistantMessage("Uncertain physical result."),
    ]);
    const uncertain = await subject.event("uncertain", "Reply once.");
    await subject.admit(uncertain);
    const uncertainReply = await subject.settled(uncertain);
    assert.equal(uncertainReply.delivery?.state, "unknown");
    await subject.admit(uncertain);
    await subject.settled(uncertain);
    assert.equal(subject.posted.length, 1);
  } finally {
    await subject.close();
  }
});

test("a Slack rate limit retries the saved intent without another native model turn", async () => {
  const subject = await setupReplies();
  try {
    subject.outcomes.push("retry", "sent");
    const event = await subject.event(
      "rate-limit",
      "Reply after the rate limit."
    );
    await subject.admit(event);
    const reply = await subject.settled(event);
    assert.equal(reply.delivery?.state, "sent");
    assert.equal(reply.attempts, 2);
    assert.equal(subject.posted.length, 2);
    assert.equal(subject.source.faux.state.callCount, 1);
  } finally {
    await subject.close();
  }
});

test("a foreign Slack event owner cannot create a native input or reply intent", async () => {
  const subject = await setupReplies();
  try {
    const event = await subject.event("foreign", "Do not disclose.");
    await assert.rejects(
      subject.admit({
        ...event,
        ownerPrincipalId: id.principal("foreign-owner"),
      }),
      (error: unknown) => error instanceof Denied
    );
    assert.equal(subject.source.faux.state.callCount, 0);
    assert.equal(subject.posted.length, 0);
    assert.equal(
      await subject.fixture
        .pi()
        .snapshot(CoordinatorReplies, event.id, context),
      undefined
    );
  } finally {
    await subject.close();
  }
});

const startSlackWork = async (
  subject: Awaited<ReturnType<typeof setupReplies>>,
  eventId: string
) => {
  subject.source.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("start_team", {
        goal: "Compare storage options in a private team.",
      }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("I started the storage team."),
  ]);
  const event = await subject.event(
    eventId,
    "Ask a private team to compare storage options."
  );
  await subject.admit(event);
  await subject.settled(event);
  await subject.fixture.waitDispatch();
  return { event, work: await subject.fixture.work("a") };
};

test("a saved work report replies once to its original Slack event destination", async () => {
  const subject = await setupReplies(true);
  try {
    const { work } = await startSlackWork(subject, "work-origin");
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        "The private team recommends SQLite for this local application."
      ),
    ]);
    const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema)({
      version: 2,
      sourceEventAddress: subject.source.address,
      report: {
        id: "report:slack-origin",
        key: work.admission.key,
        kind: "completed",
        text: "SQLite fits local storage.",
        contentDependencies: { sourceIds: [], toolIds: [] },
      },
    });
    const send = () =>
      subject.scope.handle(
        new Request("https://session.internal/team-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(delivery),
        }),
        actor
      );
    const response = await send();
    assert.equal(response.status, 200, await response.clone().text());
    const reportEvent = await coordinatorReportEvent(work, delivery.report);
    const reply = await subject.settled(reportEvent);
    assert.equal(
      reply.text,
      "The private team recommends SQLite for this local application."
    );
    assert.equal(reply.destination?.authority.eventId, "work-origin");
    assert.equal(subject.posted.length, 2);
    const repeated = await send();
    assert.equal(repeated.status, 200);
    await subject.settled(reportEvent);
    assert.equal(subject.posted.length, 2);
  } finally {
    await subject.close();
  }
});

test("subscription-only input has no answer waiter and one handback replies in its original thread", async () => {
  const subject = await setupReplies(true);
  try {
    const { event: origin, work } = await startSlackWork(
      subject,
      "subscribe-origin"
    );
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("subscribe_work", {
          workId: work.admission.key.workId,
          eventId: origin.id,
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("The work now receives explicit thread follow-ups."),
    ]);
    const subscribed = await subject.send(
      "subscribe-from-web",
      "Subscribe that work to the admitted Slack thread."
    );
    assert.equal(subscribed.status, 200);
    const webId = await botEventId(subject.source.address, {
      kind: "web",
      operationId: id.operation("subscribe-from-web"),
    });
    const web = await subject.fixture
      .pi()
      .snapshot(BotEventReceipts, webId, context);
    assert.ok(web?.receipt?.delivery.kind === "coordinator");
    await subject.fixture
      .pi()
      .waitForTask(web.receipt.delivery.taskId, context);
    const before = subject.source.faux.state.callCount;
    const followup = await subject.event(
      "subscribed-followup",
      "This belongs to another question. Return it to the coordinator."
    );
    const admitted = await subject.admit(followup);
    assert.ok(admitted.route.kind === "teams");
    assert.equal(admitted.delivery.kind, "none");
    assert.equal(subject.source.faux.state.callCount, before);
    assert.equal(
      await subject.fixture
        .pi()
        .snapshot(CoordinatorReplies, followup.id, context),
      undefined
    );
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        "I will handle this different question in the coordinator."
      ),
    ]);
    const returned = Schema.decodeUnknownSync(TeamEventReturnSchema)({
      version: 2,
      kind: "event-return",
      work: work.admission,
      eventId: followup.id,
      eventDigest: admitted.digest,
    });
    await Promise.all([
      subject.events.receiveReturn(returned, actor),
      subject.events.receiveReturn(returned, actor),
    ]);
    const reply = await subject.settled(followup);
    assert.equal(reply.destination?.authority.eventId, "subscribed-followup");
    assert.equal(
      subject.posted.filter((message) => message.text === reply.text).length,
      1
    );
    const retained = await subject.fixture.work("a");
    assert.equal(retained.reportId, null);
  } finally {
    await subject.close();
  }
});

test("a lost post outcome stays unknown after real SQLite reopen without another model or post", async () => {
  const subject = await setupReplies();
  try {
    subject.loseSentOutcome();
    const event = await subject.event(
      "lost-confirmation",
      "Send this answer once."
    );
    await subject.admit(event);
    const before = await subject.settled(event);
    assert.equal(before.delivery?.state, "unknown");
    assert.equal(subject.posted.length, 1);
    await subject.fixture.reopen();
    const pi = subject.fixture.pi();
    const restored = createCoordinatorReplies({
      pi,
      persist: () => Promise.resolve(),
      resolve: () =>
        Promise.reject(
          new Error(
            "Terminal reply reads must not load a conversation profile."
          )
        ),
      waitUntil: (promise) => {
        promise.catch(() => {});
      },
    });
    subject.fixture
      .registry()
      .install({ name: "restored.replies", tasks: [restored.definition] });
    await restored.hold();
    const after = await pi.snapshot(CoordinatorReplies, event.id, context);
    assert.deepEqual(after?.record, before);
    assert.equal(subject.fixture.source("a").faux.state.callCount, 0);
    assert.equal(subject.posted.length, 1);
  } finally {
    await subject.close();
  }
});

test("a pending reply uses the current profile after publication without blocking adoption", async () => {
  const subject = await setupReplies();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.beforePost(async () => {
      entered.resolve(true);
      await release.promise;
    });
    const event = await subject.event(
      "reply-during-publication",
      "Answer this Slack request."
    );
    const admitted = await subject.admit(event);
    assert.ok(admitted.delivery.kind === "coordinator");
    await subject.fixture.pi().waitForTask(admitted.delivery.taskId, context);
    await entered.promise;
    const next = subject.fixture.source("b").faux;
    next.setResponses([
      fauxAssistantMessage("The new profile answered the web input."),
    ]);
    subject.publish({
      ...subject.configuration,
      agent: {
        ...subject.configuration.agent,
        version: 2,
        instructions: "Use the new coordinator definition.",
        model: "coordinator-b/test",
      },
      provider: {
        ...subject.configuration.provider,
        provider: next.provider,
        model: next.getModel(),
      },
    });
    const web = await subject.send(
      "publish-while-reply-waits",
      "Use the new profile now."
    );
    assert.equal(web.status, 200, await web.clone().text());
    await waitFor(
      () => subject.fixture.pi().snapshot(Bindings, context),
      (bindings) =>
        bindings?.conversations[subject.source.address.sessionId]
          ?.agentVersion === 2
    );
    assert.equal(subject.posted.length, 0);
    release.resolve(true);
    const reply = await subject.settled(event);
    assert.equal(reply.delivery?.state, "sent");
    assert.equal(subject.posted.length, 1);
    assert.equal(subject.source.faux.state.callCount, 1);
    assert.equal(next.state.callCount, 1);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("cancelling a reply before posting records its terminal outcome and does not send", async () => {
  const subject = await setupReplies();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.beforePost(async () => {
      entered.resolve(true);
      await release.promise;
    });
    const event = await subject.event(
      "cancel-reply",
      "Do not post after cancellation."
    );
    const admitted = await subject.admit(event);
    assert.ok(admitted.delivery.kind === "coordinator");
    await subject.fixture.pi().waitForTask(admitted.delivery.taskId, context);
    await entered.promise;
    const saved = await subject.fixture
      .pi()
      .snapshot(CoordinatorReplies, event.id, context);
    assert.ok(saved?.record?.taskId);
    const { taskId } = saved.record;
    const aborted = subject.fixture.pi().abortTask(taskId, context);
    await waitFor(
      () => subject.fixture.pi().commit((tx) => tx.task(taskId), context),
      (task) => task?.abortRequested === true
    );
    release.resolve(true);
    await aborted;
    await subject.fixture.pi().waitForTask(saved.record.taskId, context);
    const stopped = await subject.fixture
      .pi()
      .snapshot(CoordinatorReplies, event.id, context);
    assert.equal(stopped?.record?.delivery?.state, "blocked");
    assert.equal(subject.posted.length, 0);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});
