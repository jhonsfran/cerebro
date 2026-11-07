/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Each stream frame and adoption assertion depends on the preceding native state. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { Denied } from "../../packages/contracts/src/failures.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";

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

test("a trigger held in its delivery check keeps its place across a publication and the next input runs under the adopted profile", async () => {
  const subject = await setupWeb(false, true);
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      fauxAssistantMessage("First retained input answered."),
      fauxAssistantMessage("Second retained input answered."),
    ]);
    subject.setDeliveryAuthorization(async (trigger) => {
      if (
        trigger.origin.kind === "web" &&
        trigger.origin.operationId === "held-old-authority"
      ) {
        entered.resolve(true);
        await release.promise;
      }
    });
    await subject.send("held-old-authority", "Keep the first accepted input.");
    await entered.promise;
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
    });
    await subject.send("current-authority", "Keep the second accepted input.");
    release.resolve(true);
    await settle(subject);
    assert.equal((await binding(subject)).agentVersion, 2);
    const snapshot = await subject.scope.read(actor);
    assert.deepEqual(
      snapshot.messages
        .filter((message) => message.role === "user")
        .map((message) => message.operationId),
      ["held-old-authority", "current-authority"]
    );
    assert.equal(subject.source.faux.state.callCount, 2);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("an old delayed delivery denial cannot discard an input permitted by the adopted profile", async () => {
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  let delayed = false;
  const subject = await setupWeb(false, true, (configuration) => ({
    ...configuration,
    ownerContext: () => Effect.succeed({ actor: { ...actor.actor } }),
    authority: {
      ...configuration.authority,
      require: (request, options) => {
        if (
          !delayed &&
          request.context !== actor &&
          request.action === "execute" &&
          request.pinnedAgent.version === 1
        ) {
          delayed = true;
          return Effect.gen(function* oldDeliveryDenial() {
            yield* Effect.promise(async () => {
              entered.resolve(true);
              await release.promise;
            });
            return yield* Effect.fail(
              new Denied({
                code: "revoked",
                reason: "The old delivery policy denied this input.",
              })
            );
          });
        }
        return configuration.authority.require(request, options);
      },
    },
  }));
  try {
    subject.source.faux.setResponses([
      fauxAssistantMessage("First input answered."),
      fauxAssistantMessage("Second input answered."),
    ]);
    await subject.send(
      "old-delivery-denial",
      "Retain the first accepted input."
    );
    await entered.promise;
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
    });
    await subject.send(
      "new-delivery-permission",
      "Retain the next accepted input."
    );
    release.resolve(true);
    await settle(subject);
    assert.equal((await binding(subject)).agentVersion, 2);
    assert.deepEqual(
      (await subject.scope.read(actor)).messages
        .filter((message) => message.role === "user")
        .map((message) => message.operationId),
      ["old-delivery-denial", "new-delivery-permission"]
    );
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test(
  "an open observer follows adoption and current revocation without dispatching model work",
  { timeout: 10_000 },
  async () => {
    const subject = await setupWeb(false, true);
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await subject.scope.handle(
        new Request("https://session.internal/observe", {
          signal: abort.signal,
        }),
        actor
      );
      assert.equal(response.status, 200);
      assert.ok(response.body);
      reader = response.body.getReader();
      const readFrame = async () => {
        const packet = await reader.read();
        assert.equal(packet.done, false);
        return JSON.parse(new TextDecoder().decode(packet.value));
      };
      const initial = await readFrame();
      assert.equal(initial.snapshot.agentVersion, 1);
      assert.equal(subject.source.faux.state.callCount, 0);
      subject.publish({
        ...subject.configuration,
        agent: { ...subject.configuration.agent, version: 2 },
      });
      await subject.send(
        "observe-publication",
        "Apply the current definition."
      );
      let frame = await readFrame();
      while (frame.type === "snapshot" && frame.snapshot.agentVersion !== 2) {
        frame = await readFrame();
      }
      assert.equal(frame.type, "snapshot");
      assert.equal(frame.snapshot.agentVersion, 2);
      await settle(subject);
      subject.setRead(false);
      frame = await readFrame();
      while (frame.type === "snapshot") {
        frame = await readFrame();
      }
      assert.deepEqual(frame, { type: "access-denied", reason: "revoked" });
      assert.equal(subject.source.faux.state.callCount, 1);
    } finally {
      abort.abort();
      await reader?.cancel();
      await subject.close();
    }
  }
);
test("a delayed read retries the whole profile after adoption and applies current read denial", async () => {
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  let delay = false;
  const subject = await setupWeb(false, true, (configuration) => ({
    ...configuration,
    authority: {
      ...configuration.authority,
      require: (request, options) => {
        if (
          delay &&
          request.action === "read" &&
          request.pinnedAgent.version === 1
        ) {
          delay = false;
          return Effect.tryPromise(async () => {
            entered.resolve(true);
            await release.promise;
            return { request, policyVersion: "old", evaluatedAt: Date.now() };
          });
        }
        return configuration.authority.require(request, options);
      },
    },
  }));
  try {
    delay = true;
    const reading = subject.scope.read(actor);
    await entered.promise;
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
      authority: {
        ...subject.configuration.authority,
        require: (request, options) =>
          request.action === "read"
            ? Effect.fail(
                new Denied({ code: "revoked", reason: "New read denied." })
              )
            : subject.configuration.authority.require(request, options),
      },
    });
    await subject.send("adopt-during-read", "Use the new definition.");
    await settle(subject);
    release.resolve(true);
    await assert.rejects(reading, (error: unknown) => error instanceof Denied);
    assert.equal((await binding(subject)).agentVersion, 2);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("a delayed old denial does not close a read authorized by the newly adopted profile", async () => {
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  let delay = false;
  const subject = await setupWeb(false, true, (configuration) => ({
    ...configuration,
    authority: {
      ...configuration.authority,
      require: (request, options) => {
        if (
          delay &&
          request.action === "read" &&
          request.pinnedAgent.version === 1
        ) {
          delay = false;
          return Effect.gen(function* delayedDenial() {
            yield* Effect.promise(async () => {
              entered.resolve(true);
              await release.promise;
            });
            return yield* Effect.fail(
              new Denied({
                code: "revoked",
                reason: "The old profile denied the read.",
              })
            );
          });
        }
        return configuration.authority.require(request, options);
      },
    },
  }));
  try {
    delay = true;
    const reading = subject.scope.read(actor);
    await entered.promise;
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
    });
    await subject.send("new-read-policy", "Adopt the current read policy.");
    await settle(subject);
    release.resolve(true);
    assert.equal((await reading).agentVersion, 2);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});
