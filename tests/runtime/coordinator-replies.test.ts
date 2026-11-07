/* oxlint-disable unicorn/no-await-expression-member -- Assertions read one field of freshly awaited durable state. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { id } from "../../packages/contracts/src/identity.ts";
import { toSlackText } from "../../packages/contracts/src/slack-text.ts";
import { TeamEventReturnSchema } from "../../packages/contracts/src/team-events.ts";
import {
  REPLY_NUDGE_ENTRY_KIND,
  TRIGGER_ENTRY_KIND,
  replyNudgeRequestId,
  triggerId,
} from "../../packages/contracts/src/triggers.ts";
import { TeamReportDeliverySchema } from "../../packages/contracts/src/work.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import {
  Replies,
  conciseSlackText,
  createReplies,
} from "../../packages/runtime/src/replies.ts";
import { context } from "./coordinator-fixture.ts";
import { replyCall, setupReplies } from "./coordinator-reply-fixture.ts";
import { actor } from "./coordinator-web-fixture.ts";
import { waitFor } from "./helpers.ts";

type Subject = Awaited<ReturnType<typeof setupReplies>>;
const toolOutputs = async (subject: Subject) => {
  const snapshot = await subject.scope.read(actor);
  return snapshot.tools
    .filter((tool) => tool.toolName === "reply_event")
    .map((tool) => ({ state: tool.state, output: tool.output }));
};

test("reply_event posts only to the event's recorded thread while concurrent web input gets no reply", async () => {
  const subject = await setupReplies();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    const slack = await subject.trigger(
      "slack-tool",
      "Answer this Slack event."
    );
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return replyCall(slack.id, "This is the exact Slack answer.");
      },
      fauxAssistantMessage("Done in the transcript too."),
      fauxAssistantMessage("This web answer stays in the web transcript."),
      replyCall(
        (await subject.trigger("slack-second", "x", "1800000001.000001")).id,
        "The second thread receives only its own answer."
      ),
      fauxAssistantMessage("Second thread done."),
    ]);
    await subject.admit(slack);
    await entered.promise;
    const web = await subject.send(
      "web-concurrent",
      "Answer this unrelated web question."
    );
    assert.equal(web.status, 200, await web.clone().text());
    release.resolve(true);
    const reply = await subject.replied(slack.id);
    assert.equal(reply.delivery?.state, "sent");
    assert.equal(reply.text, "This is the exact Slack answer.");
    assert.deepEqual(reply.destination, slack.reply);
    const webId = await triggerId(subject.source.address, {
      kind: "web",
      operationId: id.operation("web-concurrent"),
    });
    await subject.settled(webId);
    assert.equal(
      (await subject.fixture.pi().snapshot(Replies, webId, context))?.record,
      undefined
    );
    const second = await subject.trigger(
      "slack-second",
      "Answer the second thread.",
      "1800000001.000001"
    );
    await subject.admit(second);
    await subject.replied(second.id);
    await subject.settled(second.id);
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

test("a web trigger has no destination and the tool says the transcript is the reply", async () => {
  const subject = await setupReplies();
  try {
    const webId = await triggerId(subject.source.address, {
      kind: "web",
      operationId: id.operation("web-only"),
    });
    subject.source.faux.setResponses([
      replyCall(webId, "This must not be posted."),
      fauxAssistantMessage("The web answer is the transcript."),
    ]);
    const response = await subject.send("web-only", "Reply to me here.");
    assert.equal(response.status, 200);
    await subject.settled(webId);
    assert.deepEqual(await toolOutputs(subject), [
      {
        state: "failed",
        output:
          "This event has no external destination; the transcript is the reply.",
      },
    ]);
    assert.equal(subject.posted.length, 0);
    assert.equal(
      (await subject.fixture.pi().snapshot(Replies, webId, context))?.record,
      undefined
    );
  } finally {
    await subject.close();
  }
});

test("a replayed reply call is idempotent and a different text for the same event conflicts", async () => {
  const subject = await setupReplies();
  try {
    const slack = await subject.trigger("one-reply", "Reply once.");
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "reply_event",
            { eventId: slack.id, text: "The one reply." },
            { id: "first" }
          ),
          fauxToolCall(
            "reply_event",
            { eventId: slack.id, text: "The one reply." },
            { id: "same" }
          ),
          fauxToolCall(
            "reply_event",
            { eventId: slack.id, text: "Another reply." },
            { id: "other" }
          ),
        ],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("Replied."),
    ]);
    await subject.admit(slack);
    await subject.settled(slack.id);
    const reply = await subject.replied(slack.id);
    assert.equal(reply.text, "The one reply.");
    assert.deepEqual(
      (await toolOutputs(subject)).map((output) => output.state),
      ["succeeded", "succeeded", "failed"]
    );
    assert.match(
      (await toolOutputs(subject))[2]?.output ?? "",
      /already has another reply/u
    );
    assert.equal(subject.posted.length, 1);
  } finally {
    await subject.close();
  }
});

test("a forgotten Slack reply gets one durable nudge that survives a waiting burst and stays out of the web transcript", async () => {
  const subject = await setupReplies();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    const slack = await subject.trigger("forgotten", "Please answer me.");
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("I answered only in the transcript.");
      },
      replyCall(slack.id, "Here is the Slack answer after the nudge."),
      fauxAssistantMessage("Answered the burst and the reply."),
    ]);
    await subject.admit(slack);
    await entered.promise;
    const burst = ["burst-one", "burst-two"];
    for (const operationId of burst) {
      // oxlint-disable-next-line no-await-in-loop -- The burst waits in Pi's inbox in arrival order.
      const response = await subject.send(operationId, `Web ${operationId}.`);
      assert.equal(response.status, 200);
    }
    const burstIds = await Promise.all(
      burst.map((operationId) =>
        triggerId(subject.source.address, {
          kind: "web",
          operationId: id.operation(operationId),
        })
      )
    );
    await waitFor(
      () => Promise.all(burstIds.map((value) => subject.placement(value))),
      (placements) => placements.every((value) => value.kind === "queued"),
      10_000,
      10
    );
    release.resolve(true);
    const reply = await subject.replied(slack.id);
    assert.equal(reply.text, "Here is the Slack answer after the nudge.");
    const nudge = await subject.fixture
      .pi()
      .commit(
        (tx) =>
          tx.submissionByRequest(
            subject.source.native.id,
            replyNudgeRequestId(slack.id)
          ),
        context
      );
    assert.equal(nudge?.status, "done");
    await Promise.all(burstIds.map((value) => subject.settled(value)));
    const entries = await subject.source.native.entries(
      {},
      64,
      undefined,
      context
    );
    const kinds = entries.items
      .toSorted((left, right) => left.id - right.id)
      .map((entry) => entry.kind)
      .filter((kind) =>
        [TRIGGER_ENTRY_KIND, REPLY_NUDGE_ENTRY_KIND, "pi.assistant"].includes(
          kind
        )
      );
    assert.deepEqual(kinds, [
      TRIGGER_ENTRY_KIND,
      "pi.assistant",
      TRIGGER_ENTRY_KIND,
      TRIGGER_ENTRY_KIND,
      REPLY_NUDGE_ENTRY_KIND,
      "pi.assistant",
      "pi.assistant",
    ]);
    const nudges = await subject.fixture.pi().commit(async (tx) => {
      const page = await tx.scanEntries(
        { conversationId: subject.source.native.id },
        64
      );
      return page.items.filter((entry) => entry.kind === REPLY_NUDGE_ENTRY_KIND)
        .length;
    }, context);
    assert.equal(nudges, 1);
    assert.equal(subject.source.faux.state.callCount, 3);
    const snapshot = await subject.scope.read(actor);
    assert.deepEqual(
      snapshot.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["Web burst-one.", "Web burst-two."]
    );
    assert.deepEqual(snapshot.queuedInputs, []);
    assert.equal(subject.posted.length, 1);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("a nudge run keeps its human cause, so start_team still succeeds", async () => {
  const subject = await setupReplies(true);
  try {
    const slack = await subject.trigger(
      "nudge-cause",
      "Ask a team to compare storage options."
    );
    subject.source.faux.setResponses([
      fauxAssistantMessage("Thinking about it."),
      fauxAssistantMessage(
        fauxToolCall("start_team", { goal: "Compare storage options." }),
        { stopReason: "toolUse" }
      ),
      replyCall(slack.id, "I started the storage team."),
      fauxAssistantMessage("Started and replied."),
    ]);
    await subject.admit(slack);
    await subject.replied(slack.id);
    await subject.fixture.waitDispatch();
    const work = await subject.fixture.work("a");
    assert.equal(work.humanOperationId, slack.id);
    assert.equal(
      subject.fixture.calls.filter((command) => command.kind === "start")
        .length,
      1
    );
  } finally {
    await subject.close();
  }
});

test("an exact Slack status saves a passive answer and its reply without a model call", async () => {
  const subject = await setupReplies();
  try {
    const status = await subject.trigger("local-status", "status");
    const admitted = await subject.admit(status);
    assert.equal(admitted.route.kind, "local-answer");
    const reply = await subject.replied(status.id);
    assert.equal(reply.delivery?.state, "sent");
    assert.match(reply.text, /no active or queued team work/u);
    assert.equal(subject.source.faux.state.callCount, 0);
    assert.equal(
      await subject.fixture
        .pi()
        .commit(
          (tx) => tx.submissionByRequest(subject.source.native.id, status.id),
          context
        ),
      undefined
    );
    assert.equal(subject.posted.length, 1);
    await subject.admit(status);
    assert.equal(subject.posted.length, 1);
  } finally {
    await subject.close();
  }
});

test("the saved Slack projection converts Markdown and keeps at most one hundred words", async () => {
  const subject = await setupReplies();
  try {
    const raw = `# Result\n**Done** [details](https://example.com/result) ${Array.from({ length: 150 }, (_, index) => `word${index}`).join(" ")}`;
    const slack = await subject.trigger("markdown", "Give the exact result.");
    subject.source.faux.setResponses([
      replyCall(slack.id, raw),
      fauxAssistantMessage("Replied."),
    ]);
    await subject.admit(slack);
    const reply = await subject.replied(slack.id);
    assert.equal(reply.text, conciseSlackText(toSlackText(raw)));
    assert.match(
      reply.text,
      /^\*Result\*\n\*Done\* <https:\/\/example.com\/result\|details> /u
    );
    assert.equal(reply.text.split(/\s+/u).length, 100);
    assert.equal(subject.posted[0]?.text, reply.text);
  } finally {
    await subject.close();
  }
});

for (const denial of ["link", "source", "content"] as const) {
  test(`current ${denial} denial records a blocked reply with no post`, async () => {
    const subject = await setupReplies();
    try {
      const slack = await subject.trigger(
        `denied-${denial}`,
        "Prepare an answer."
      );
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
          return replyCall(slack.id, "An answer that must stay undisclosed.");
        },
        fauxAssistantMessage("Blocked."),
      ]);
      await subject.admit(slack);
      const reply = await subject.replied(slack.id);
      assert.equal(reply.delivery?.state, "blocked");
      assert.equal(subject.posted.length, 0);
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
    const blocked = await subject.trigger("boundary", "Answer before change.");
    const uncertain = await subject.trigger("uncertain", "Reply once.");
    subject.source.faux.setResponses([
      replyCall(blocked.id, "Blocked at the boundary."),
      fauxAssistantMessage("Done."),
      replyCall(uncertain.id, "Uncertain physical result."),
      fauxAssistantMessage("Done."),
    ]);
    await subject.admit(blocked);
    const blockedReply = await subject.replied(blocked.id);
    assert.equal(blockedReply.delivery?.state, "blocked");
    assert.equal(subject.posted.length, 0);
    subject.setLinked(true);
    subject.beforePost();
    subject.outcomes.push("unknown");
    await subject.admit(uncertain);
    const uncertainReply = await subject.replied(uncertain.id);
    assert.equal(uncertainReply.delivery?.state, "unknown");
    await subject.admit(uncertain);
    assert.equal(subject.posted.length, 1);
  } finally {
    await subject.close();
  }
});

test("a Slack rate limit retries the saved reply without another model turn", async () => {
  const subject = await setupReplies();
  try {
    subject.outcomes.push("retry", "sent");
    const slack = await subject.trigger("rate-limit", "Reply after limit.");
    subject.source.faux.setResponses([
      replyCall(slack.id, "Posted after a retry."),
      fauxAssistantMessage("Done."),
    ]);
    await subject.admit(slack);
    const reply = await subject.replied(slack.id);
    assert.equal(reply.delivery?.state, "sent");
    assert.equal(reply.attempts, 2);
    assert.equal(subject.posted.length, 2);
    assert.equal(subject.source.faux.state.callCount, 2);
  } finally {
    await subject.close();
  }
});

test("a reply call cannot name an event of another owner", async () => {
  const subject = await setupReplies();
  try {
    const slack = await subject.trigger("foreign", "Do not disclose.");
    await assert.rejects(
      subject.admit({ ...slack, ownerPrincipalId: id.principal("foreign") }),
      () => true
    );
    subject.source.faux.setResponses([
      replyCall(slack.id, "No receipt exists."),
      fauxAssistantMessage("Nothing to reply to."),
    ]);
    const response = await subject.send("ask", "Reply to that event.");
    assert.equal(response.status, 200);
    await subject.settled(
      await triggerId(subject.source.address, {
        kind: "web",
        operationId: id.operation("ask"),
      })
    );
    assert.equal((await toolOutputs(subject))[0]?.state, "failed");
    assert.equal(subject.posted.length, 0);
  } finally {
    await subject.close();
  }
});

const startSlackWork = async (subject: Subject, eventId: string) => {
  const slack = await subject.trigger(
    eventId,
    "Ask a private team to compare storage options."
  );
  subject.source.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("start_team", {
        goal: "Compare storage options in a private team.",
      }),
      { stopReason: "toolUse" }
    ),
    replyCall(slack.id, "I started the storage team."),
    fauxAssistantMessage("Started."),
  ]);
  await subject.admit(slack);
  await subject.replied(slack.id);
  await subject.settled(slack.id);
  await subject.fixture.waitDispatch();
  return { slack, work: await subject.fixture.work("a") };
};

test("a Team report carries its cause's destination and the coordinator replies once to that thread", async () => {
  const subject = await setupReplies(true);
  try {
    const { work } = await startSlackWork(subject, "work-origin");
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
    const receipt = await subject.fixture.receipt(reportId);
    assert.equal(receipt.trigger.reply?.authority.eventId, "work-origin");
    const reply = await subject.replied(reportId);
    assert.equal(reply.text, "The private team recommends SQLite.");
    assert.equal(reply.destination.authority.eventId, "work-origin");
    assert.equal(subject.posted.length, 2);
    const repeated = await send();
    assert.equal(repeated.status, 200);
    assert.equal(subject.posted.length, 2);
  } finally {
    await subject.close();
  }
});

test("a Team work started from a Slack thread subscribes to it, follow-ups reach the Team, and a handback replies in the thread", async () => {
  const subject = await setupReplies(true);
  try {
    const { work } = await startSlackWork(subject, "subscribe-origin");
    const before = subject.source.faux.state.callCount;
    const followup = await subject.trigger(
      "subscribed-followup",
      "This belongs to another question. Return it to the coordinator."
    );
    const admitted = await subject.admit(followup);
    assert.ok(admitted.route.kind === "teams");
    assert.deepEqual(
      admitted.route.recipients.map((recipient) => recipient.key),
      [work.admission.key]
    );
    assert.equal(subject.source.faux.state.callCount, before);
    assert.equal((await subject.placement(followup.id)).kind, "routed");
    subject.source.faux.setResponses([
      replyCall(followup.id, "I will handle this in the coordinator."),
      fauxAssistantMessage("Handled."),
    ]);
    const returned = Schema.decodeUnknownSync(TeamEventReturnSchema)({
      version: 2,
      kind: "event-return",
      work: work.admission,
      eventId: followup.id,
      eventDigest: admitted.digest,
    });
    await Promise.all([
      subject.triggers.receiveReturn(returned, actor),
      subject.triggers.receiveReturn(returned, actor),
    ]);
    const reply = await subject.replied(followup.id);
    assert.equal(reply.destination.authority.eventId, "subscribed-followup");
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

test("a lost post outcome stays unknown after reopen without another model call or post", async () => {
  const subject = await setupReplies();
  try {
    subject.loseSentOutcome();
    const slack = await subject.trigger("lost", "Send this answer once.");
    subject.source.faux.setResponses([
      replyCall(slack.id, "Sent once."),
      fauxAssistantMessage("Done."),
    ]);
    await subject.admit(slack);
    const before = await subject.replied(slack.id);
    assert.equal(before.delivery?.state, "unknown");
    assert.equal(subject.posted.length, 1);
    await subject.fixture.reopen();
    const pi = subject.fixture.pi();
    const restored = createReplies({
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
    const after = await pi.snapshot(Replies, slack.id, context);
    assert.deepEqual(after?.record, before);
    assert.equal(subject.fixture.source("a").faux.state.callCount, 0);
    assert.equal(subject.posted.length, 1);
  } finally {
    await subject.close();
  }
});

test("a pending reply posts under the current profile after a publication lands", async () => {
  const subject = await setupReplies();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.beforePost(async () => {
      entered.resolve(true);
      await release.promise;
    });
    const slack = await subject.trigger("publication", "Answer this.");
    subject.source.faux.setResponses([
      replyCall(slack.id, "Posted after the publication."),
      fauxAssistantMessage("Done."),
    ]);
    await subject.admit(slack);
    await entered.promise;
    const next = subject.fixture.source("b").faux;
    next.setResponses([fauxAssistantMessage("The new profile answered.")]);
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
      provider: {
        ...subject.configuration.provider,
        provider: next.provider,
        model: next.getModel(),
      },
    });
    const web = await subject.send("after-publication", "Use the new one.");
    assert.equal(web.status, 200, await web.clone().text());
    await subject.drain();
    await waitFor(
      () => subject.fixture.pi().snapshot(Bindings, context),
      (bindings) =>
        bindings?.conversations[subject.source.address.sessionId]
          ?.agentVersion === 2,
      10_000,
      20
    );
    assert.equal(subject.posted.length, 0);
    release.resolve(true);
    const reply = await subject.replied(slack.id);
    assert.equal(reply.delivery?.state, "sent");
    assert.equal(subject.posted.length, 1);
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
    const slack = await subject.trigger("cancel", "Do not post.");
    subject.source.faux.setResponses([
      replyCall(slack.id, "Cancelled before posting."),
      fauxAssistantMessage("Done."),
    ]);
    await subject.admit(slack);
    await entered.promise;
    const saved = await subject.fixture
      .pi()
      .snapshot(Replies, slack.id, context);
    assert.ok(saved?.record?.taskId);
    const { taskId } = saved.record;
    const aborted = subject.fixture.pi().abortTask(taskId, context);
    await waitFor(
      () => subject.fixture.pi().commit((tx) => tx.task(taskId), context),
      (task) => task?.abortRequested === true,
      10_000,
      10
    );
    release.resolve(true);
    await aborted;
    await subject.fixture.pi().waitForTask(taskId, context);
    const stopped = await subject.fixture
      .pi()
      .snapshot(Replies, slack.id, context);
    assert.equal(stopped?.record?.delivery?.state, "blocked");
    assert.equal(subject.posted.length, 0);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});
