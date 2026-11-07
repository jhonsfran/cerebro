/* oxlint-disable unicorn/no-await-expression-member -- Assertions read one field of freshly awaited durable state. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { Denied, Unavailable } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { triggerId } from "../../packages/contracts/src/triggers.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { Receipts } from "../../packages/runtime/src/triggers.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";
import { waitFor } from "./helpers.ts";

type Subject = Awaited<ReturnType<typeof setupWeb>>;
const binding = async (subject: Subject) => {
  const saved = await subject.fixture.pi().snapshot(Bindings, context);
  const value = saved?.conversations[subject.source.address.sessionId];
  assert.ok(value);
  return value;
};
const webId = (subject: Subject, operationId: string) =>
  triggerId(subject.source.address, {
    kind: "web",
    operationId: id.operation(operationId),
  });
const settle = async (subject: Subject, operationId: string) => {
  await subject.drain();
  return await subject.settled(await webId(subject, operationId));
};
const schedule = (subject: Subject, operationId: string) =>
  subject.scope.handle(
    new Request("https://session.internal/control", {
      method: "POST",
      body: JSON.stringify({
        command: {
          kind: "schedule",
          operationId,
          instruction: "Use the current control authority.",
          runAt: Date.now() + 60_000,
        },
      }),
    }),
    actor
  );

test("a missing frozen definition makes old reads and control writes unavailable", async () => {
  const subject = await setupWeb(false, true);
  const { reminders } = subject.scope;
  try {
    await subject.fixture.pi().commit(async (tx) => {
      const bindings = await tx.doc(Bindings);
      bindings.conversations[subject.source.address.sessionId].refresh = {
        agentVersion: 99,
      };
    }, context);
    await assert.rejects(
      subject.scope.advancePublication(),
      /The fixture definition does not exist/u
    );
    await assert.rejects(subject.scope.read(actor), Unavailable);
    const rejected = await schedule(subject, "after-stage-failure");
    assert.equal(rejected.status, 503);
    assert.deepEqual(await reminders.list(), []);
    assert.deepEqual(subject.recoveries, ["requested"]);
    assert.equal(subject.source.faux.state.callCount, 0);
  } finally {
    await subject.close();
  }
});

for (const { operation, check } of [
  { operation: "schedule", check: 1 },
  { operation: "schedule", check: 2 },
  { operation: "stop", check: 1 },
] as const) {
  test(`a delayed old ${operation} denial at check ${check} repeats current authorization before mutation`, async () => {
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    let delay = false;
    let checks = 0;
    const subject = await setupWeb(false, true, (configuration) => ({
      ...configuration,
      authority: {
        ...configuration.authority,
        require: (request, options) => {
          const matches =
            delay &&
            request.action === "execute" &&
            request.pinnedAgent.version === 1 &&
            (operation === "schedule" ? !!request.model : !request.model);
          if (matches) {
            checks += 1;
          }
          if (matches && checks === check) {
            delay = false;
            return Effect.gen(function* oldControlDenial() {
              yield* Effect.promise(async () => {
                entered.resolve(true);
                await release.promise;
              });
              return yield* Effect.fail(
                new Denied({ code: "revoked", reason: "Old control denied." })
              );
            });
          }
          return configuration.authority.require(request, options);
        },
      },
    }));
    try {
      delay = true;
      const pending =
        operation === "schedule"
          ? schedule(subject, "old-denied-control")
          : subject.stop();
      await entered.promise;
      subject.publish({
        ...subject.configuration,
        agent: { ...subject.configuration.agent, version: 2 },
      });
      await subject.send("current-control", "Adopt the current profile.");
      await subject.drain();
      await waitFor(
        () => binding(subject),
        (value) => value.agentVersion === 2
      );
      release.resolve(true);
      const response = await pending;
      assert.equal(response.status, 200, await response.clone().text());
      if (operation === "schedule") {
        const reminders = await subject.scope.reminders.list();
        assert.deepEqual(
          reminders.map((value) => value.id),
          ["reminder:old-denied-control"]
        );
      } else {
        assert.equal(subject.nativeAborts(), 1);
      }
    } finally {
      release.resolve(true);
      await subject.close();
    }
  });
}

for (const held of [false, true]) {
  test(`new web input admits after a physical model publication with ${held ? "a held" : "no live"} old turn`, async () => {
    let currentModel = "fixture/test";
    const subject = await setupWeb(false, true, (configuration) => ({
      ...configuration,
      authority: {
        ...configuration.authority,
        require: (request, options) =>
          request.model && request.model !== currentModel
            ? Effect.fail(
                new Denied({
                  code: "revoked",
                  reason: "The current agent does not enable this capability.",
                })
              )
            : configuration.authority.require(request, options),
      },
    }));
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    try {
      if (held) {
        subject.source.faux.setResponses([
          async () => {
            entered.resolve(true);
            await release.promise;
            return fauxAssistantMessage("Old physical request complete.");
          },
        ]);
        await subject.source.native.submit(
          { type: "input", requestId: "old-model", content: "Finish first." },
          context
        );
        subject.fixture.pi().resume();
        await entered.promise;
      }
      const next = subject.fixture.source("b").faux;
      next.setResponses([fauxAssistantMessage("New physical model answered.")]);
      currentModel = "coordinator-b/test";
      subject.publish({
        ...subject.configuration,
        agent: {
          ...subject.configuration.agent,
          version: 2,
          model: currentModel,
          instructions: "Use the new physical model.",
        },
        provider: {
          ...subject.configuration.provider,
          model: next.getModel(),
          provider: next.provider,
        },
      });
      const response = await subject.send("new-model", "Save this input now.");
      assert.equal(response.status, 200, await response.clone().text());
      const newModel = await webId(subject, "new-model");
      if (held) {
        await waitFor(
          () => binding(subject),
          (value) => value.refresh?.agentVersion === 2,
          10_000,
          20
        );
        assert.equal(
          await subject.triggers.drain(subject.source.native.id),
          "waiting"
        );
        assert.equal((await subject.placement(newModel)).kind, "backlog");
        assert.deepEqual(
          (await subject.scope.read(actor)).queuedInputs.map((input) => ({
            operationId: input.operationId,
            text: input.text,
          })),
          [{ operationId: "new-model", text: "Save this input now." }]
        );
        const waiting = await binding(subject);
        assert.equal(waiting.agentVersion, 1);
        assert.equal(next.state.callCount, 0);
      }
      release.resolve(true);
      const completed = await settle(subject, "new-model");
      assert.equal(completed.kind, "done");
      const applied = await binding(subject);
      assert.equal(applied.agentVersion, 2);
      assert.equal(next.state.callCount, 1);
      assert.equal(subject.source.faux.state.callCount, held ? 1 : 0);
      const placed = await subject.fixture
        .pi()
        .commit(
          (tx) =>
            completed.kind === "done" ? tx.entry(completed.answer) : undefined,
          context
        );
      const [answer] = placed?.model ?? [];
      assert.ok(answer?.role === "assistant");
      assert.equal(answer.provider, next.provider.id);
      assert.deepEqual(
        answer.content.flatMap((block) =>
          block.type === "text" ? [block.text] : []
        ),
        ["New physical model answered."]
      );
    } finally {
      release.resolve(true);
      await subject.close();
    }
  });
}

for (const publish of [false, true]) {
  test(`a model denial after admission readiness ${publish ? "revisits a new publication" : "settles an unchanged permission denial"}`, async () => {
    const entered = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    let currentModel = "fixture/test";
    let delay = true;
    const subject = await setupWeb(false, true, (configuration) => ({
      ...configuration,
      authority: {
        ...configuration.authority,
        require: (request, options) =>
          Effect.gen(function* currentModelEntitlement() {
            if (delay && request.model) {
              delay = false;
              yield* Effect.promise(async () => {
                entered.resolve(true);
                await release.promise;
              });
            }
            if (request.model && request.model !== currentModel) {
              return yield* Effect.fail(
                new Denied({ code: "revoked", reason: "Model disabled." })
              );
            }
            return yield* configuration.authority.require(request, options);
          }),
      },
    }));
    try {
      const response = await subject.send("readiness-race", "Keep this input.");
      assert.equal(response.status, 200, await response.clone().text());
      await entered.promise;
      const next = subject.fixture.source("b").faux;
      currentModel = "coordinator-b/test";
      if (publish) {
        subject.publish({
          ...subject.configuration,
          agent: {
            ...subject.configuration.agent,
            version: 2,
            model: currentModel,
          },
          provider: {
            ...subject.configuration.provider,
            model: next.getModel(),
            provider: next.provider,
          },
        });
      }
      release.resolve(true);
      const completed = await settle(subject, "readiness-race");
      assert.equal(completed.kind, publish ? "done" : "withdrawn");
      const applied = await binding(subject);
      assert.equal(applied.agentVersion, publish ? 2 : 1);
      assert.equal(next.state.callCount, publish ? 1 : 0);
      assert.equal(subject.source.faux.state.callCount, 0);
    } finally {
      release.resolve(true);
      await subject.close();
    }
  });
}

for (const revoked of ["execute", "read", "content"] as const) {
  test(`web admission after publication still rejects revoked ${revoked} access`, async () => {
    let revocation = false;
    const subject = await setupWeb(false, true, (configuration) => ({
      ...configuration,
      authority: {
        ...configuration.authority,
        require: (request, options) =>
          revocation && request.action === revoked
            ? Effect.fail(
                new Denied({
                  code: "revoked",
                  reason: "Current access revoked.",
                })
              )
            : configuration.authority.require(request, options),
      },
      checkDependencies: (...args) =>
        revocation && revoked === "content"
          ? Effect.fail(
              new Denied({
                code: "revoked",
                reason: "Current content revoked.",
              })
            )
          : configuration.checkDependencies(...args),
    }));
    try {
      subject.publish({
        ...subject.configuration,
        agent: { ...subject.configuration.agent, version: 2 },
      });
      revocation = true;
      const response = await subject.send(
        "revoked-input",
        "Do not admit this."
      );
      assert.equal(response.status, 403, await response.clone().text());
      assert.equal(subject.source.faux.state.callCount, 0);
      const applied = await binding(subject);
      assert.deepEqual(applied.refresh, null);
      const saved = await subject.fixture
        .pi()
        .snapshot(Receipts, await webId(subject, "revoked-input"), context);
      assert.equal(saved?.receipt, undefined);
    } finally {
      await subject.close();
    }
  });
}
