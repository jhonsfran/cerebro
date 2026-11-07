/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Compaction and publication assertions follow the actual native task boundaries. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  CompactionTask,
  CompactionEntry,
  LiveDoc,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";
import { waitFor } from "./helpers.ts";

const binding = async (subject: Awaited<ReturnType<typeof setupWeb>>) => {
  const saved = await subject.fixture.pi().snapshot(Bindings, context);
  const value = saved?.conversations[subject.source.address.sessionId];
  assert.ok(value);
  return value;
};
const settle = async (subject: Awaited<ReturnType<typeof setupWeb>>) => {
  await subject.drain();
  await subject.source.native.waitForIdle(context);
};

test("an accepted manual compaction receipt still replays while new native admission is closed", async () => {
  const subject = await setupWeb(false, true);
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      fauxAssistantMessage("First retained answer."),
      fauxAssistantMessage("Second retained answer."),
      fauxAssistantMessage("Third retained answer."),
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("A summary of the accepted history.");
      },
      fauxAssistantMessage("The held event finished."),
    ]);
    for (let index = 0; index < 3; index += 1) {
      const input = await subject.source.native.submit(
        {
          type: "input",
          requestId: `manual-seed-${index}`,
          content: "Retained conversation context. ".repeat(4000),
        },
        context
      );
      await input.wait(context);
    }
    const command = {
      kind: "compact" as const,
      operationId: "accepted-compact",
    };
    const taskId = await subject.scope.compaction.request(command);
    await entered.promise;
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
    });
    await subject.send(
      "after-manual-compact",
      "Adopt after the accepted compaction."
    );
    await waitFor(
      () => binding(subject),
      (value) => value.refresh !== null
    );
    const replay = await subject.scope.handle(
      new Request("https://session.internal/control", {
        method: "POST",
        body: JSON.stringify({ command }),
      }),
      actor
    );
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal((await replay.json()).value.id, String(taskId));
    assert.equal((await binding(subject)).agentVersion, 1);
    release.resolve(true);
    await subject.fixture.pi().waitForTask(taskId, context);
    await settle(subject);
    assert.equal((await binding(subject)).agentVersion, 2);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});
test("background compaction keeps its old provider until its summary and queued write finish", async () => {
  const subject = await setupWeb(false, true);
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      fauxAssistantMessage("First context retained."),
      fauxAssistantMessage("Second context retained."),
      fauxAssistantMessage("Third context retained."),
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage(
          "A compact summary of the original conversation."
        );
      },
      fauxAssistantMessage("The held event can continue."),
    ]);
    for (let index = 0; index < 3; index += 1) {
      const input = await subject.source.native.submit(
        {
          type: "input",
          requestId: `compaction-seed-${index}`,
          content: "Retained conversation context. ".repeat(4000),
        },
        context
      );
      await input.wait(context);
    }
    const compact = await subject.fixture.pi().commit(async (tx) => {
      const live = await tx.doc(LiveDoc, subject.source.native.id);
      const taskId = await tx.createTask(
        CompactionTask,
        { reason: "threshold" },
        {
          conversationId: subject.source.native.id,
          ownership: { kind: "conversation" },
          background: true,
        }
      );
      live.compactions = [
        { taskId, reason: "threshold", blocking: false, attempt: 1 },
      ];
      return taskId;
    }, context);
    subject.fixture.pi().resume();
    await waitFor(
      () => subject.source.faux.state.callCount,
      (count) => count >= 4,
      5000
    );
    await entered.promise;
    await subject.source.native.waitForIdle(context);
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
    });
    await subject.send(
      "after-background-compaction",
      "Use the current instructions after compaction."
    );
    await waitFor(
      () => binding(subject),
      (value) => value.refresh !== null
    );
    assert.equal((await binding(subject)).agentVersion, 1);
    release.resolve(true);
    await subject.fixture.pi().waitForTask(compact, context);
    await settle(subject);
    assert.equal((await binding(subject)).agentVersion, 2);
    const entries = await subject.source.native.entries(
      {},
      64,
      undefined,
      context
    );
    assert.ok(entries.items.some((entry) => CompactionEntry.is(entry)));
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("a new compaction request cannot save a recovery job after publication closes native admission", async () => {
  const subject = await setupWeb(false, true);
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("The old request finished.");
      },
      fauxAssistantMessage("The held input finished."),
    ]);
    const old = await subject.source.native.submit(
      {
        type: "input",
        requestId: "old-before-compact",
        content: "Hold the admitted native work.",
      },
      context
    );
    subject.fixture.pi().resume();
    await entered.promise;
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
    });
    await subject.send(
      "publish-before-compact",
      "Use the published definition."
    );
    await waitFor(
      () => binding(subject),
      (value) => value.refresh !== null
    );
    const response = await subject.scope.handle(
      new Request("https://session.internal/control", {
        method: "POST",
        body: JSON.stringify({
          command: { kind: "compact", operationId: "not-admitted-compact" },
        }),
      }),
      actor
    );
    assert.equal(response.status, 503);
    assert.equal(
      subject.fixture.jobs.has("cerebro-compact:source-a:not-admitted-compact"),
      false
    );
    release.resolve(true);
    await old.wait(context);
    await settle(subject);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});
