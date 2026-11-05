import assert from "node:assert/strict";
import { test } from "node:test";

import { botEventId } from "../../packages/contracts/src/bot-events.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import { createCoordinatorWeb } from "../../packages/runtime/src/coordinator-web.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";

test("legacy replay compares the current placed input after authorization waits", async () => {
  const subject = await setupWeb();
  const firstEntered = Promise.withResolvers<boolean>();
  const firstRelease = Promise.withResolvers<boolean>();
  const secondEntered = Promise.withResolvers<boolean>();
  const secondRelease = Promise.withResolvers<boolean>();
  const authorizationEntered = Promise.withResolvers<boolean>();
  const authorizationRelease = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      async () => {
        firstEntered.resolve(true);
        await firstRelease.promise;
        return fauxAssistantMessage("The first legacy answer.");
      },
      async () => {
        secondEntered.resolve(true);
        await secondRelease.promise;
        return fauxAssistantMessage("The second legacy answer.");
      },
    ]);
    const first = await subject.source.native.submit(
      {
        type: "input",
        requestId: "legacy-running",
        content: "First legacy input.",
      },
      context
    );
    await firstEntered.promise;
    const queued = await subject.source.native.submit(
      {
        type: "input",
        requestId: "legacy-queued",
        content: "Original accepted legacy text.",
      },
      context
    );
    const before = await queued.status(context);
    assert.equal(before.status, "queued");
    const web = createCoordinatorWeb({
      pi: subject.fixture.pi(),
      native: subject.source.native,
      events: subject.events,
      runtime: {
        ...subject.scope.runtime,
        authorize: async (...args) => {
          await subject.scope.runtime.authorize(...args);
          if (args[1] === "coordinate") {
            authorizationEntered.resolve(true);
            await authorizationRelease.promise;
          }
        },
      },
      replayHandled: subject.scope.routeHuman,
    });
    const rejected = assert.rejects(
      web.send("legacy-queued", "Changed legacy text.", actor),
      { _tag: "Conflict", code: "digest-mismatch" }
    );
    await authorizationEntered.promise;
    firstRelease.resolve(true);
    await first.wait(context);
    await secondEntered.promise;
    const after = await queued.status(context);
    assert.equal(after.status, "placed");
    authorizationRelease.resolve(true);
    await rejected;
    const replay = await web.send(
      "legacy-queued",
      "Original accepted legacy text.",
      actor
    );
    assert.equal(replay.accepted, false);
    secondRelease.resolve(true);
    await queued.wait(context);
    const snapshot = await subject.scope.read(actor);
    assert.deepEqual(
      snapshot.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["First legacy input.", "Original accepted legacy text."]
    );
    assert.equal(subject.source.faux.state.callCount, 2);
  } finally {
    firstRelease.resolve(true);
    secondRelease.resolve(true);
    authorizationRelease.resolve(true);
    await subject.close();
  }
});

test("web input rejects an operation ID already owned by a native write", async () => {
  const subject = await setupWeb();
  try {
    const operationId = "compaction:123";
    const write = await subject.source.native.submit(
      {
        type: "write",
        requestId: operationId,
        entry: {
          kind: "cerebro.saved-context",
          model: [
            {
              role: "user",
              content: "An existing saved context write.",
              timestamp: Date.now(),
            },
          ],
        },
      },
      context
    );
    const saved = await write.wait(context);
    assert.equal(saved.type, "write");
    assert.equal(saved.status, "done");
    const response = await subject.send(
      operationId,
      "A distinct human request."
    );
    assert.equal(response.status, 409);
    const current = await subject.fixture
      .pi()
      .commit(
        (tx) => tx.submissionByRequest(subject.source.native.id, operationId),
        context
      );
    assert.equal(current?.id, saved.id);
    assert.equal(current?.type, "write");
    const eventId = await botEventId(subject.source.address, {
      kind: "web",
      operationId: id.operation(operationId),
    });
    const event = await subject.fixture
      .pi()
      .snapshot(BotEventReceipts, eventId, context);
    assert.equal(event, undefined);
    const snapshot = await subject.scope.read(actor);
    assert.equal(
      snapshot.messages.some(
        (message) => message.text === "A distinct human request."
      ),
      false
    );
    assert.equal(subject.source.faux.state.callCount, 0);
  } finally {
    await subject.close();
  }
});
