import assert from "node:assert/strict";
import { test } from "node:test";

import { botEventId } from "../../packages/contracts/src/bot-events.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { webEventForkPointIn } from "../../packages/runtime/src/coordinator-event-input.ts";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";
import { waitFor } from "./helpers.ts";

const receipt = async (
  subject: Awaited<ReturnType<typeof setupWeb>>,
  operationId: string
) => {
  const eventId = await botEventId(subject.source.address, {
    kind: "web",
    operationId: id.operation(operationId),
  });
  const saved = await subject.fixture
    .pi()
    .snapshot(BotEventReceipts, eventId, context);
  assert.ok(saved?.receipt);
  return saved.receipt;
};
const settled = async (
  subject: Awaited<ReturnType<typeof setupWeb>>,
  operationId: string
) => {
  const saved = await receipt(subject, operationId);
  if (saved.delivery.kind === "coordinator") {
    await subject.fixture.pi().waitForTask(saved.delivery.taskId, context);
  }
  return await receipt(subject, operationId);
};

test("ordinary web chat without Team configuration retains one original operation and visible message", async () => {
  const subject = await setupWeb();
  try {
    const response = await subject.send(
      "hello-operation",
      "Hello. What can you help me with?"
    );
    assert.equal(response.status, 200, await response.clone().text());
    const accepted = await response.json();
    assert.equal(accepted.value.accepted, true);
    assert.equal(accepted.value.operationId, "hello-operation");
    const saved = await settled(subject, "hello-operation");
    assert.equal(saved.route.kind, "coordinator");
    assert.ok(
      saved.delivery.kind === "coordinator" &&
        saved.delivery.admission.kind === "settled" &&
        saved.delivery.admission.outcome === "done"
    );
    const before = await subject.scope.read(actor);
    assert.deepEqual(
      before.messages
        .filter((message) => message.role === "user")
        .map((message) => ({
          text: message.text,
          operationId: message.operationId,
        })),
      [
        {
          text: "Hello. What can you help me with?",
          operationId: "hello-operation",
        },
      ]
    );
    assert.equal(subject.source.faux.state.callCount, 1);
    const replay = await subject.send(
      "hello-operation",
      "Hello. What can you help me with?"
    );
    assert.equal(replay.status, 200);
    const body = await replay.json();
    assert.equal(body.value.accepted, false);
    const snapshot = await subject.scope.read(actor);
    assert.equal(
      snapshot.messages.filter((message) => message.role === "user").length,
      1
    );
    assert.equal(subject.source.faux.state.callCount, 1);
    const changed = await subject.send(
      "hello-operation",
      "A different question."
    );
    assert.equal(changed.status, 409);
  } finally {
    await subject.close();
  }
});

test("concurrent retries keep one newly accepted web receipt and one replay", async () => {
  const subject = await setupWeb();
  try {
    const responses = await Promise.all([
      subject.send("concurrent-web", "Admit this once."),
      subject.send("concurrent-web", "Admit this once."),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200]
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json())
    );
    assert.deepEqual(bodies.map((body) => body.value.accepted).toSorted(), [
      false,
      true,
    ]);
    await settled(subject, "concurrent-web");
    assert.equal(subject.source.faux.state.callCount, 1);
    const snapshot2 = await subject.scope.read(actor);
    assert.equal(
      snapshot2.messages.filter((message) => message.role === "user").length,
      1
    );
  } finally {
    await subject.close();
  }
});

test("an accepted web input stays visible as pending while delivery authorization waits", async () => {
  const subject = await setupWeb();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.setDeliveryAuthorization(async () => {
      entered.resolve(true);
      await release.promise;
    });
    const response = await subject.send(
      "held-operation",
      "Keep this exact text while I reload."
    );
    assert.equal(response.status, 200);
    await entered.promise;
    const pending = await subject.scope.read(actor);
    assert.deepEqual(
      pending.queuedInputs.map((input) => ({
        text: input.text,
        operationId: input.operationId,
      })),
      [
        {
          text: "Keep this exact text while I reload.",
          operationId: "held-operation",
        },
      ]
    );
    assert.equal(
      pending.messages.filter((message) => message.role === "user").length,
      0
    );
    assert.equal(subject.source.faux.state.callCount, 0);
    release.resolve(true);
    await settled(subject, "held-operation");
    const completed = await subject.scope.read(actor);
    assert.deepEqual(completed.queuedInputs, []);
    assert.equal(
      completed.messages.filter(
        (message) => message.operationId === "held-operation"
      ).length,
      1
    );
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test(
  "Stop withdraws an accepted held event before its authorization is released",
  { timeout: 5000 },
  async () => {
    const subject = await setupWeb();
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    try {
      subject.setDeliveryAuthorization(async () => {
        entered.resolve(true);
        await release.promise;
      });
      const sendResponse = await subject.send(
        "stop-held",
        "Do not run after I press Stop."
      );
      assert.equal(sendResponse.status, 200);
      await entered.promise;
      const stopResponse = await subject.stop();
      assert.equal(stopResponse.status, 200);
      const snapshot3 = await subject.scope.read(actor);
      assert.deepEqual(snapshot3.queuedInputs, []);
      const saved = await receipt(subject, "stop-held");
      assert.ok(saved.delivery.kind === "coordinator");
      const task = await subject.fixture
        .pi()
        .commit(
          (tx) =>
            tx.task(
              saved.delivery.kind === "coordinator" ? saved.delivery.taskId : 0
            ),
          context
        );
      assert.equal(task?.abortRequested, true);
      release.resolve(true);
      await settled(subject, "stop-held");
      const snapshot = await subject.scope.read(actor);
      assert.deepEqual(snapshot.queuedInputs, []);
      assert.equal(subject.source.faux.state.callCount, 0);
      assert.equal(
        snapshot.messages.filter((message) => message.role === "user").length,
        0
      );
    } finally {
      release.resolve(true);
      await subject.close();
    }
  }
);

test(
  "a next web request proceeds while a stopped held authorizer still ignores cancellation",
  { timeout: 5000 },
  async () => {
    const subject = await setupWeb();
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    try {
      subject.setDeliveryAuthorization(async (event) => {
        if (
          event.source.kind === "web" &&
          event.source.operationId === "stopped-first"
        ) {
          entered.resolve(true);
          await release.promise;
        }
      });
      const sendResponse2 = await subject.send(
        "stopped-first",
        "Stop this first request."
      );
      assert.equal(sendResponse2.status, 200);
      await entered.promise;
      const stopResponse2 = await subject.stop();
      assert.equal(stopResponse2.status, 200);
      const sendResponse3 = await subject.send(
        "after-stop",
        "Answer the next request."
      );
      assert.equal(sendResponse3.status, 200);
      await settled(subject, "after-stop");
      assert.equal(subject.source.faux.state.callCount, 1);
      const snapshot = await subject.scope.read(actor);
      assert.deepEqual(
        snapshot.messages
          .filter((message) => message.role === "user")
          .map((message) => message.operationId),
        ["after-stop"]
      );
      release.resolve(true);
      await settled(subject, "stopped-first");
      assert.equal(subject.source.faux.state.callCount, 1);
      const snapshot4 = await subject.scope.read(actor);
      assert.deepEqual(snapshot4.queuedInputs, []);
    } finally {
      release.resolve(true);
      await subject.close();
    }
  }
);

test("foreground Stop leaves independent private Team work running", async () => {
  const subject = await setupWeb(true);
  try {
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("start_team", {
          goal: "Keep the independent team running.",
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("The team is running in the background."),
    ]);
    const sendResponse4 = await subject.send(
      "background-work",
      "Start an independent task."
    );
    assert.equal(sendResponse4.status, 200);
    await settled(subject, "background-work");
    await subject.fixture.waitDispatch();
    const before = await subject.fixture.work("a");
    const stopResponse3 = await subject.stop();
    assert.equal(stopResponse3.status, 200);
    const resolvedValue = await subject.fixture.work("a");
    assert.deepEqual(resolvedValue.status, before.status);
    assert.equal(
      subject.fixture.calls.filter((command) => command.kind === "cancel")
        .length,
      0
    );
  } finally {
    await subject.close();
  }
});

test("accepted legacy native input replays before placement without a new event or model request", async () => {
  const subject = await setupWeb();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("First legacy answer.");
      },
      fauxAssistantMessage("Queued legacy answer."),
    ]);
    const first = await subject.source.native.submit(
      {
        type: "input",
        content: "Already running legacy input.",
        requestId: "legacy-running",
      },
      context
    );
    await entered.promise;
    const queued = await subject.source.native.submit(
      {
        type: "input",
        content: "Original queued legacy text.",
        requestId: "legacy-queued",
        whenBusy: "followUp",
      },
      context
    );
    const submissionStatus = await queued.status(context);
    assert.equal(submissionStatus.status, "queued");
    const replay = await subject.send(
      "legacy-queued",
      "Original queued legacy text."
    );
    assert.equal(replay.status, 200);
    const body2 = await replay.json();
    assert.equal(body2.value.accepted, false);
    const sendResponse5 = await subject.send(
      "legacy-queued",
      "Changed queued text."
    );
    assert.equal(sendResponse5.status, 409);
    const eventId = await botEventId(subject.source.address, {
      kind: "web",
      operationId: id.operation("legacy-queued"),
    });
    assert.equal(
      await subject.fixture.pi().snapshot(BotEventReceipts, eventId, context),
      undefined
    );
    assert.equal(subject.source.faux.state.callCount, 1);
    release.resolve(true);
    const settlement = await first.wait(context);
    assert.equal(settlement.status, "done");
    const settlement2 = await queued.wait(context);
    assert.equal(settlement2.status, "done");
    assert.equal(subject.source.faux.state.callCount, 2);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("local status and stop retain exact answer entries without model access or a native submission", async () => {
  const subject = await setupWeb();
  try {
    subject.setExecute(false);
    await Promise.all(
      (["status", "stop"] as const).map(async (action) => {
        const response = await subject.send(`local-${action}`, action);
        assert.equal(response.status, 200, await response.clone().text());
        const saved = await receipt(subject, `local-${action}`);
        assert.equal(saved.delivery.kind, "none");
        assert.ok(saved.route.kind === "local-answer");
        const answer = await subject.fixture
          .pi()
          .commit(
            (tx) =>
              tx.entry(
                saved.route.kind === "local-answer"
                  ? saved.route.answerEntryId
                  : 0
              ),
            context
          );
        assert.match(
          JSON.stringify(answer?.model),
          /There is no active or queued team work/u
        );
        const input = await subject.fixture
          .pi()
          .commit(
            (tx) =>
              tx.submissionByRequest(
                subject.source.native.id,
                saved.input.version === 2
                  ? saved.input.event.id
                  : saved.input.id
              ),
            context
          );
        assert.equal(input, undefined);
        const sendResponse6 = await subject.send(`local-${action}`, action);
        assert.equal(sendResponse6.status, 200);
      })
    );
    const view = await subject.scope.read(actor);
    assert.equal(
      view.messages.filter((message) => message.role === "user").length,
      2
    );
    assert.equal(
      view.messages.filter((message) => message.role === "assistant").length,
      2
    );
    assert.equal(subject.source.faux.state.callCount, 0);
    const sendResponse7 = await subject.send(
      "new-question",
      "Please research this."
    );
    assert.equal(sendResponse7.status, 403);
  } finally {
    await subject.close();
  }
});

test("web boundaries accept 16000 characters and reject 16001 without another event", async () => {
  const subject = await setupWeb();
  try {
    const text = "x".repeat(16_000);
    const sendResponse8 = await subject.send("maximum-web", text);
    assert.equal(sendResponse8.status, 200);
    await settled(subject, "maximum-web");
    const snapshot5 = await subject.scope.read(actor);
    assert.equal(
      snapshot5.messages.find((message) => message.role === "user")?.text,
      text
    );
    const sendResponse9 = await subject.send("oversized-web", `${text}x`);
    assert.equal(sendResponse9.status, 400);
    assert.equal(subject.source.faux.state.callCount, 1);
  } finally {
    await subject.close();
  }
});

test("a native queued web input appears once with its original operation while the first answer waits", async () => {
  const subject = await setupWeb();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("First answer.");
      },
      fauxAssistantMessage("Second answer."),
    ]);
    const sendResponse10 = await subject.send("first-web", "First question.");
    assert.equal(sendResponse10.status, 200);
    await entered.promise;
    const sendResponse11 = await subject.send("second-web", "Second question.");
    assert.equal(sendResponse11.status, 200);
    const saved = await receipt(subject, "second-web");
    assert.ok(saved.delivery.kind === "coordinator");
    await waitFor(
      async () => {
        const current = await receipt(subject, "second-web");
        if (
          current.delivery.kind !== "coordinator" ||
          current.delivery.admission.kind !== "submitted"
        ) {
          return;
        }
        const submission = await subject.fixture
          .pi()
          .submission(current.delivery.admission.submissionId, context);
        return await submission?.status(context);
      },
      (record) => record?.status === "queued",
      10_000
    );
    const value = await subject.scope.read(actor);
    assert.equal(
      value.queuedInputs.filter((input) => input.operationId === "second-web")
        .length,
      1
    );
    release.resolve(true);
    await settled(subject, "first-web");
    await settled(subject, "second-web");
    const completed = await subject.scope.read(actor);
    assert.deepEqual(
      completed.messages
        .filter((message) => message.role === "user")
        .map((message) => message.operationId),
      ["first-web", "second-web"]
    );
    assert.equal(subject.source.faux.state.callCount, 2);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("a visible receipt-backed web entry remains a real Pi fork point while fabricated custom input does not", async () => {
  const subject = await setupWeb();
  try {
    const sendResponse12 = await subject.send(
      "fork-web",
      "Keep this fork snapshot."
    );
    assert.equal(sendResponse12.status, 200);
    const saved = await settled(subject, "fork-web");
    assert.ok(
      saved.delivery.kind === "coordinator" &&
        saved.delivery.admission.kind === "settled" &&
        saved.delivery.admission.outcome === "done"
    );
    const input = await subject.fixture
      .pi()
      .commit(
        (tx) =>
          tx.entry(
            saved.delivery.kind === "coordinator" &&
              saved.delivery.admission.kind === "settled" &&
              saved.delivery.admission.outcome === "done"
              ? saved.delivery.admission.entry
              : 0
          ),
        context
      );
    assert.ok(input);
    const valid = (point: typeof input) =>
      subject.fixture.pi().commit(
        (tx) =>
          webEventForkPointIn(tx, {
            point,
            nativeId: subject.source.native.id,
            address: subject.source.address,
            ownerPrincipalId: actor.actor.id,
          }),
        context
      );
    assert.equal(await valid(input), true);
    assert.equal(
      await valid({
        ...input,
        data: {
          eventId: "not-admitted",
          source: "web",
          operationId: "fork-web",
        },
      }),
      false
    );
    assert.equal(
      await valid({
        ...input,
        data: {
          eventId: "not-admitted",
          source: "slack",
          operationId: "fork-web",
        },
      }),
      false
    );
    const fork = await subject.fixture.pi().commit(
      (tx) =>
        tx.forkConversation(subject.source.native.id, input.id, {
          ownership: { kind: "ownerless" },
        }),
      context
    );
    const native = await subject.fixture.pi().conversation(fork.id, context);
    assert.ok(native);
    assert.match(
      JSON.stringify(await native.entries({}, 100, undefined, context)),
      /Keep this fork snapshot/u
    );
    assert.equal(subject.source.faux.state.callCount, 1);
  } finally {
    await subject.close();
  }
});
