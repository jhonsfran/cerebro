import assert from "node:assert/strict";
import { test } from "node:test";

import { id } from "../../packages/contracts/src/identity.ts";
import { triggerId } from "../../packages/contracts/src/triggers.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";
import { waitFor } from "./helpers.ts";

type Subject = Awaited<ReturnType<typeof setupWeb>>;
const webId = (subject: Subject, operationId: string) =>
  triggerId(subject.source.address, {
    kind: "web",
    operationId: id.operation(operationId),
  });
const settled = async (subject: Subject, operationId: string) =>
  subject.settled(await webId(subject, operationId));

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
    const placement = await settled(subject, "hello-operation");
    assert.equal(placement.kind, "done");
    const receipt = await subject.fixture.receipt(
      await webId(subject, "hello-operation")
    );
    assert.equal(receipt.route.kind, "inbox");
    assert.equal(receipt.trigger.reply, null);
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
    const snapshot = await subject.scope.read(actor);
    assert.equal(
      snapshot.messages.filter((message) => message.role === "user").length,
      1
    );
  } finally {
    await subject.close();
  }
});

test("an accepted web input stays visible as queued while delivery authorization waits", async () => {
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
  "Stop withdraws a backlogged web trigger before its delivery check finishes",
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
      const stopped = await subject.scope.read(actor);
      assert.deepEqual(stopped.queuedInputs, []);
      release.resolve(true);
      const placement = await settled(subject, "stop-held");
      assert.equal(placement.kind, "withdrawn");
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
    const sendResponse = await subject.send(
      "background-work",
      "Start an independent task."
    );
    assert.equal(sendResponse.status, 200);
    await settled(subject, "background-work");
    await subject.fixture.waitDispatch();
    const before = await subject.fixture.work("a");
    const stopResponse = await subject.stop();
    assert.equal(stopResponse.status, 200);
    const after = await subject.fixture.work("a");
    assert.deepEqual(after.status, before.status);
    assert.equal(
      subject.fixture.calls.filter((command) => command.kind === "cancel")
        .length,
      0
    );
  } finally {
    await subject.close();
  }
});

test("local status and stop keep exact answers without model access or a native submission", async () => {
  const subject = await setupWeb();
  try {
    subject.setModelEnabled(false);
    await Promise.all(
      (["status", "stop"] as const).map(async (action) => {
        const response = await subject.send(`local-${action}`, action);
        assert.equal(response.status, 200, await response.clone().text());
        const triggerIdValue = await webId(subject, `local-${action}`);
        const saved = await subject.fixture.receipt(triggerIdValue);
        assert.ok(saved.route.kind === "local-answer");
        const answer = await subject.fixture
          .pi()
          .commit(
            (tx) =>
              tx.entry(
                saved.route.kind === "local-answer"
                  ? saved.route.answerEntry
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
              tx.submissionByRequest(subject.source.native.id, triggerIdValue),
            context
          );
        assert.equal(input, undefined);
        const replay = await subject.send(`local-${action}`, action);
        assert.equal(replay.status, 200);
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
    const research = await subject.send(
      "new-question",
      "Please research this."
    );
    assert.equal(research.status, 200);
    const withdrawn = await settled(subject, "new-question");
    assert.equal(withdrawn.kind, "withdrawn");
    assert.equal(subject.source.faux.state.callCount, 0);
  } finally {
    await subject.close();
  }
});

test("web boundaries accept 16000 characters and reject 16001 without another event", async () => {
  const subject = await setupWeb();
  try {
    const text = "x".repeat(16_000);
    const accepted = await subject.send("maximum-web", text);
    assert.equal(accepted.status, 200);
    await settled(subject, "maximum-web");
    const snapshot = await subject.scope.read(actor);
    assert.equal(
      snapshot.messages.find((message) => message.role === "user")?.text,
      text
    );
    const rejected = await subject.send("oversized-web", `${text}x`);
    assert.equal(rejected.status, 400);
    assert.equal(subject.source.faux.state.callCount, 1);
  } finally {
    await subject.close();
  }
});

test("a web input queued in Pi appears once with its original operation while the first answer waits", async () => {
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
    const first = await subject.send("first-web", "First question.");
    assert.equal(first.status, 200);
    await entered.promise;
    const second = await subject.send("second-web", "Second question.");
    assert.equal(second.status, 200);
    await waitFor(
      async () => subject.placement(await webId(subject, "second-web")),
      (placement) => placement.kind === "queued",
      10_000,
      10
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
