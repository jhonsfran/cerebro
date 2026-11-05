import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { botEventId } from "../../packages/contracts/src/bot-events.ts";
import type { BotEvent } from "../../packages/contracts/src/bot-events.ts";
import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import { context, setup } from "./coordinator-fixture.ts";

const actor = {
  actor: {
    id: id.principal("owner-A"),
    organizationId: id.organization("org-A"),
    kind: "human" as const,
    state: "active" as const,
  },
};
const eventFor = async (
  fixture: Awaited<ReturnType<typeof setup>>,
  name: string,
  operationId: string
): Promise<BotEvent> => {
  const coordinator = fixture.source(name).address;
  const source = {
    kind: "web",
    operationId: id.operation(operationId),
  } as const;
  return {
    version: 1,
    id: await botEventId(coordinator, source),
    coordinator,
    ownerPrincipalId: actor.actor.id,
    source,
    replyTo: null,
    content: { text: operationId, reference: null },
    dependencies: { sourceIds: [], toolIds: [] },
  };
};

test("accepted native input order survives delayed first authorization while another bot progresses", async () => {
  const fixture = await setup();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    const first = await eventFor(fixture, "a", "first-accepted");
    const second = await eventFor(fixture, "a", "second-accepted");
    const independent = await eventFor(fixture, "b", "independent-bot");
    fixture
      .source("a")
      .faux.setResponses([
        fauxAssistantMessage("First answer."),
        fauxAssistantMessage("Second answer."),
      ]);
    fixture.setEventDeliveryAuthorization(async (event) => {
      if (event.id === first.id) {
        entered.resolve(true);
        await release.promise;
      }
    });
    const firstReceipt = await fixture.events().admit(first, actor);
    await entered.promise;
    const secondReceipt = await fixture.events().admit(second, actor);
    const independentReceipt = await fixture.events().admit(independent, actor);
    assert.ok(
      firstReceipt.delivery.kind === "coordinator" &&
        secondReceipt.delivery.kind === "coordinator" &&
        independentReceipt.delivery.kind === "coordinator"
    );
    await fixture.pi().waitForTask(independentReceipt.delivery.taskId, context);
    await delay(1100);
    const waiting = await fixture
      .pi()
      .commit(
        (tx) =>
          tx.task(
            secondReceipt.delivery.kind === "coordinator"
              ? secondReceipt.delivery.taskId
              : 0
          ),
        context
      );
    assert.ok(waiting && waiting.state.status !== "terminal");
    assert.equal(waiting.state.checkpoint.attempt, 0);
    assert.deepEqual(fixture.eventSubmissions, [independent.id]);
    assert.equal(fixture.source("a").faux.state.callCount, 0);
    release.resolve(true);
    await Promise.all([
      fixture.pi().waitForTask(firstReceipt.delivery.taskId, context),
      fixture.pi().waitForTask(secondReceipt.delivery.taskId, context),
    ]);
    assert.deepEqual(
      fixture.eventSubmissions.filter((eventId) => eventId !== independent.id),
      [first.id, second.id]
    );
    const entries = await fixture
      .source("a")
      .native.entries({}, 100, undefined, context);
    assert.deepEqual(
      entries.items
        .toSorted((left, right) => left.id - right.id)
        .filter((entry) => entry.kind === "cerebro.bot-event-input")
        .map((entry) => entry.model?.[0])
        .map((message) => (message?.role === "user" ? message.content : "")),
      ["first-accepted", "second-accepted"]
    );
  } finally {
    release.resolve(true);
    await fixture.close();
  }
});

test("a denied predecessor settles and releases the next accepted input", async () => {
  const fixture = await setup();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    const first = await eventFor(fixture, "a", "denied-first");
    const second = await eventFor(fixture, "a", "valid-next");
    fixture.setEventDeliveryAuthorization(async (event) => {
      if (event.id === first.id) {
        entered.resolve(true);
        await release.promise;
        throw new Denied({ code: "revoked", reason: "Current access denied." });
      }
    });
    const firstReceipt = await fixture.events().admit(first, actor);
    await entered.promise;
    const secondReceipt = await fixture.events().admit(second, actor);
    assert.ok(
      firstReceipt.delivery.kind === "coordinator" &&
        secondReceipt.delivery.kind === "coordinator"
    );
    release.resolve(true);
    await Promise.all([
      fixture.pi().waitForTask(firstReceipt.delivery.taskId, context),
      fixture.pi().waitForTask(secondReceipt.delivery.taskId, context),
    ]);
    const saved = await fixture
      .pi()
      .snapshot(BotEventReceipts, first.id, context);
    assert.ok(
      saved?.receipt?.delivery.kind === "coordinator" &&
        saved.receipt.delivery.admission.kind === "settled" &&
        saved.receipt.delivery.admission.outcome === "blocked"
    );
    assert.deepEqual(fixture.eventSubmissions, [second.id]);
  } finally {
    release.resolve(true);
    await fixture.close();
  }
});
