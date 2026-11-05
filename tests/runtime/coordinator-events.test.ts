import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Effect, Schema } from "effect";

import {
  BotEventSchema,
  botEventId,
} from "../../packages/contracts/src/bot-events.ts";
import type { BotEvent } from "../../packages/contracts/src/bot-events.ts";
import {
  Conflict,
  Denied,
  Unavailable,
} from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  WorkIdSchema,
  WorkReportIdSchema,
} from "../../packages/contracts/src/work.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { eventOf } from "../../packages/runtime/src/coordinator-event-state.ts";
import {
  BotEventQueue,
  BotEventReceipts,
  createCoordinatorEvents,
} from "../../packages/runtime/src/coordinator-events.ts";
import { chatPresentation } from "../../packages/runtime/src/pi-harness.ts";
import { context, setup } from "./coordinator-fixture.ts";

const platformImports = registerHooks({
  resolve(specifier, importContext, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: "data:text/javascript,export {};" };
    }
    try {
      return nextResolve(specifier, importContext);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_MODULE_NOT_FOUND" &&
        specifier.startsWith(".")
      ) {
        return nextResolve(`${specifier}.ts`, importContext);
      }
      throw error;
    }
  },
});
const { ConversationScope } =
  await import("../../packages/runtime/src/conversation-scope.ts");
platformImports.deregister();

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
  source?: BotEvent["source"]
): Promise<BotEvent> => {
  const coordinator = fixture.source(name).address;
  const origin = source ?? {
    kind: "web",
    operationId: id.operation("event-one"),
  };
  return Schema.decodeUnknownSync(BotEventSchema)({
    version: 1,
    id: await botEventId(coordinator, origin),
    coordinator,
    ownerPrincipalId: actor.actor.id,
    source: origin,
    replyTo: null,
    content: { text: "A compact event.", reference: null },
    dependencies: { sourceIds: [], toolIds: [] },
  });
};
const saved = async (
  fixture: Awaited<ReturnType<typeof setup>>,
  event: BotEvent
) => {
  const document = await fixture
    .pi()
    .snapshot(BotEventReceipts, event.id, context);
  assert.ok(document?.receipt);
  return document.receipt;
};
const pending = async (fixture: Awaited<ReturnType<typeof setup>>) => {
  const queue = await fixture.pi().snapshot(BotEventQueue, context);
  return queue?.pending ?? {};
};
const wait = async (
  fixture: Awaited<ReturnType<typeof setup>>,
  event: BotEvent
) => {
  const receipt = await saved(fixture, event);
  await fixture.pi().waitForTask(receipt.delivery.taskId, context);
  return await saved(fixture, event);
};

test("duplicate event IDs save one intent and one exact native answer reference", async () => {
  const fixture = await setup();
  try {
    const event = await eventFor(fixture, "a");
    const receipts = await Promise.all([
      fixture.events().admit(event, actor),
      fixture.events().admit(event, actor),
    ]);
    assert.equal(receipts[0]?.delivery.taskId, receipts[1]?.delivery.taskId);
    const receipt = await wait(fixture, event);
    assert.equal(receipt.duplicates, 1);
    assert.equal(fixture.eventSubmissions.length, 1);
    assert.equal(receipt.delivery.admission.kind, "settled");
    assert.ok(
      receipt.delivery.admission.kind === "settled" &&
        receipt.delivery.admission.outcome === "done"
    );
    const exact = await fixture
      .pi()
      .commit(
        (tx) => tx.submissionByRequest(fixture.source("a").native.id, event.id),
        context
      );
    assert.equal(exact?.id, receipt.delivery.admission.submissionId);
    assert.equal(exact?.status, "done");
    const entries = await fixture.source("a").native.entries(
      {
        minEntryId: receipt.delivery.admission.answer,
        maxEntryId: receipt.delivery.admission.answer,
      },
      1,
      undefined,
      context
    );
    assert.match(JSON.stringify(entries.items), /Coordinator result/u);
    const input = await fixture
      .pi()
      .commit(
        (tx) =>
          tx.entry(
            receipt.delivery.admission.kind === "settled" &&
              receipt.delivery.admission.outcome === "done"
              ? receipt.delivery.admission.entry
              : 0
          ),
        context
      );
    assert.equal(input?.kind, "cerebro.bot-event-input");
    assert.deepEqual(await pending(fixture), {});
  } finally {
    await fixture.close();
  }
});

test("changed digest conflicts without changing a saved receipt or adding a task", async () => {
  const fixture = await setup();
  try {
    const event = await eventFor(fixture, "a");
    await fixture
      .pi()
      .commit((tx) => fixture.events().enqueueIn(tx, event), context);
    const before = await saved(fixture, event);
    await assert.rejects(
      fixture.pi().commit(
        (tx) =>
          fixture.events().enqueueIn(tx, {
            ...event,
            content: { ...event.content, text: "Changed." },
          }),
        context
      ),
      (error: unknown) => error instanceof Conflict
    );
    assert.deepEqual(await saved(fixture, event), before);
    const queue = await fixture.pi().snapshot(BotEventQueue, context);
    assert.equal(Object.keys(queue?.pending ?? {}).length, 1);
    assert.equal(fixture.eventSubmissions.length, 0);
  } finally {
    await fixture.close();
  }
});

test("an intent committed before submission recovers on reopen without an observer", async () => {
  const fixture = await setup();
  try {
    const event = await eventFor(fixture, "a");
    await fixture
      .pi()
      .commit((tx) => fixture.events().enqueueIn(tx, event), context);
    const held = await saved(fixture, event);
    assert.equal(held.delivery.admission.kind, "held");
    await fixture.reopen();
    const settled = await wait(fixture, event);
    assert.equal(settled.delivery.admission.kind, "settled");
    assert.equal(fixture.eventSubmissions.length, 1);
  } finally {
    await fixture.close();
  }
});

for (const point of ["before", "after"] as const) {
  test(`a crash ${point} native submission keeps one applied version claim and one input`, async () => {
    const fixture = await setup();
    try {
      const event = await eventFor(fixture, "a");
      const entered = fixture.pauseEventSubmit(point);
      await fixture.events().admit(event, actor);
      await entered;
      const claimed = await saved(fixture, event);
      assert.deepEqual(claimed.delivery.admission, {
        kind: "claimed",
        agentVersion: 1,
        requestId: event.id,
      });
      fixture.clearEventPause();
      await fixture.reopen();
      const receipt = await wait(fixture, event);
      assert.ok(
        receipt.delivery.admission.kind === "settled" &&
          receipt.delivery.admission.outcome === "done"
      );
      assert.equal(receipt.delivery.admission.agentVersion, 1);
      assert.deepEqual(fixture.eventSubmissions, [event.id]);
    } finally {
      await fixture.close();
    }
  });
}

test("delivery rechecks dependencies and settles revoked events without native work or raw errors", async () => {
  const fixture = await setup();
  try {
    const event = {
      ...(await eventFor(fixture, "a")),
      dependencies: { sourceIds: [id.source("private-source")], toolIds: [] },
    };
    await fixture
      .pi()
      .commit((tx) => fixture.events().enqueueIn(tx, event), context);
    fixture.revokeContent("private-source");
    await fixture.reopen();
    const receipt = await wait(fixture, event);
    assert.equal(receipt.delivery.admission.kind, "settled");
    assert.ok(
      receipt.delivery.admission.kind === "settled" &&
        receipt.delivery.admission.outcome === "blocked"
    );
    assert.equal(fixture.eventSubmissions.length, 0);
    assert.equal(
      JSON.stringify(receipt.delivery.admission).includes(
        "Event content revoked"
      ),
      false
    );
    assert.deepEqual(await pending(fixture), {});
  } finally {
    await fixture.close();
  }
});

test("the inbox bounds external and internal pending work through native settlement", async () => {
  const fixture = await setup();
  try {
    const external = await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        eventFor(fixture, "a", {
          kind: "web",
          operationId: id.operation(`external-${index}`),
        })
      )
    );
    for (const event of external.slice(0, 64)) {
      // oxlint-disable-next-line no-await-in-loop -- Each receipt consumes capacity in the same saved index.
      await fixture
        .pi()
        .commit((tx) => fixture.events().enqueueIn(tx, event), context);
    }
    const overflow = external.at(64);
    assert.ok(overflow);
    await assert.rejects(
      fixture
        .pi()
        .commit((tx) => fixture.events().enqueueIn(tx, overflow), context),
      (error: unknown) => error instanceof Unavailable
    );
    assert.equal(
      await fixture.pi().snapshot(BotEventReceipts, overflow.id, context),
      undefined
    );
    const internal = await Promise.all(
      Array.from({ length: 33 }, (_, index) =>
        eventFor(fixture, "a", {
          kind: "savedtimer",
          scheduleId: "timer",
          occurrenceId: String(index),
        })
      )
    );
    for (const event of internal.slice(0, 32)) {
      // oxlint-disable-next-line no-await-in-loop -- Reserved internal capacity must remain available after external overflow.
      await fixture
        .pi()
        .commit((tx) => fixture.events().enqueueIn(tx, event), context);
    }
    const internalOverflow = internal.at(32);
    assert.ok(internalOverflow);
    await assert.rejects(
      fixture
        .pi()
        .commit(
          (tx) => fixture.events().enqueueIn(tx, internalOverflow),
          context
        ),
      (error: unknown) => error instanceof Unavailable
    );
    assert.equal(Object.keys((await pending(fixture)) ?? {}).length, 96);
    await fixture.reopen();
    await Promise.all(
      [...external.slice(0, 64), ...internal.slice(0, 32)].map((event) =>
        wait(fixture, event)
      )
    );
    assert.equal(fixture.eventSubmissions.length, 96);
    assert.deepEqual(await pending(fixture), {});
  } finally {
    await fixture.close();
  }
});

test("internal report input cannot reuse a human operation to authorize start_team", async () => {
  const fixture = await setup();
  try {
    const event = await eventFor(fixture, "a", {
      kind: "teamreport",
      key: {
        organizationId: actor.actor.organizationId,
        ownerPrincipalId: actor.actor.id,
        workId: Schema.decodeUnknownSync(WorkIdSchema)("report-work"),
      },
      reportId: Schema.decodeUnknownSync(WorkReportIdSchema)("report-one"),
      outcome: "completed",
    });
    await fixture.source("a").coordinator.rememberHumanOperation(event.id);
    fixture.source("a").faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("start_team", {
          goal: "Unauthorized report follow-on.",
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("The report was summarized."),
    ]);
    await fixture.events().admit(event, actor);
    await wait(fixture, event);
    const ledger = await fixture.ledger();
    assert.equal(ledger.documents, 0);
    const history = await fixture.source("a").native.context(context);
    assert.match(JSON.stringify(history), /current human request/u);
  } finally {
    await fixture.close();
  }
});

test("new event inputs reject oversized content and keep source identity independent of report outcome", async () => {
  const fixture = await setup();
  try {
    const event = await eventFor(fixture, "a");
    await assert.rejects(
      fixture.pi().commit(
        (tx) =>
          fixture.events().enqueueIn(tx, {
            ...event,
            content: { text: "x".repeat(2001), reference: null },
          }),
        context
      )
    );
    assert.equal(
      await fixture.pi().snapshot(BotEventReceipts, event.id, context),
      undefined
    );
  } finally {
    await fixture.close();
  }
});

test("queued expiry saves one terminal notice with its status and recovers its coordinator turn", async () => {
  const fixture = await setup(1000, true);
  try {
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "First active goal." },
      "first-active"
    );
    await fixture.invoke(
      "b",
      "start_team",
      { goal: "Second active goal." },
      "second-active"
    );
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "Queued goal." },
      "queued-goal"
    );
    const queued = await fixture.work("a");
    assert.equal(queued.status.kind, "queued");
    fixture.advance(1001);
    await fixture.source("a").coordinator.wake();
    const terminal = await fixture.work("a");
    assert.equal(terminal.status.kind, "failed");
    const page = await fixture
      .events()
      .list(fixture.source("a").address, actor);
    const notices = page.items.filter(
      (receipt) =>
        eventOf(receipt).source.kind === "coordinator-terminalnotice" &&
        eventOf(receipt).source.key.workId === queued.admission.key.workId
    );
    assert.equal(notices.length, 1);
    const [notice] = notices;
    assert.ok(notice);
    await fixture.reopen();
    await wait(fixture, eventOf(notice));
    await fixture.source("a").coordinator.wake();
    assert.equal(
      fixture.eventSubmissions.filter(
        (requestId) => requestId === eventOf(notice).id
      ).length,
      1
    );
  } finally {
    await fixture.close();
  }
});

test("permanent dispatch failure saves one sanitized coordinator notice with the failed status", async () => {
  const fixture = await setup(600_000, true);
  try {
    fixture.denyDispatch();
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "Transport failure." },
      "failed-dispatch"
    );
    await fixture.waitDispatch();
    const work = await fixture.work("a");
    assert.equal(work.status.kind, "failed");
    const page = await fixture
      .events()
      .list(fixture.source("a").address, actor);
    assert.equal(page.items.length, 1);
    const [notice] = page.items;
    assert.ok(notice);
    assert.equal(eventOf(notice).source.kind, "coordinator-terminalnotice");
    assert.equal(
      eventOf(notice).content.text,
      "The team command could not be delivered."
    );
    await wait(fixture, eventOf(notice));
    await fixture.source("a").coordinator.wake();
    assert.equal(fixture.eventSubmissions.length, 1);
    assert.equal(JSON.stringify(notice).includes("Private transport"), false);
  } finally {
    await fixture.close();
  }
});

test("a claimed event revoked across restart settles without renewed native execution", async () => {
  const fixture = await setup();
  try {
    const event = await eventFor(fixture, "a");
    const entered = fixture.pauseEventSubmit("before");
    await fixture.events().admit(event, actor);
    await entered;
    fixture.revoke("a");
    fixture.clearEventPause();
    await fixture.reopen();
    const receipt = await wait(fixture, event);
    assert.ok(
      receipt.delivery.admission.kind === "settled" &&
        receipt.delivery.admission.outcome === "blocked"
    );
    assert.equal(fixture.eventSubmissions.length, 0);
  } finally {
    await fixture.close();
  }
});

test("a held event resolves the current source and applied version after later scopes restore", async () => {
  const fixture = await setup();
  try {
    const event = await eventFor(fixture, "c");
    await fixture
      .pi()
      .commit((tx) => fixture.events().enqueueIn(tx, event), context);
    fixture.setPinVersion(2);
    await fixture.reopen();
    const receipt = await wait(fixture, event);
    assert.ok(
      receipt.delivery.admission.kind === "settled" &&
        receipt.delivery.admission.outcome === "done"
    );
    assert.equal(receipt.delivery.admission.agentVersion, 2);
    assert.equal(receipt.nativeId, fixture.source("c").native.id);
  } finally {
    await fixture.close();
  }
});

test("submitted internal input retains capacity and cancellation withdraws it before another model turn", async () => {
  const fixture = await setup();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    const source = fixture.source("a");
    source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("Foreground completed.");
      },
    ]);
    const foreground = await source.native.submit(
      {
        type: "input",
        content: "Foreground request.",
        requestId: "foreground",
      },
      context
    );
    await entered.promise;
    const event = await eventFor(fixture, "a");
    const receipt = await fixture.events().admit(event, actor);
    let current = await saved(fixture, event);
    for (
      let attempt = 0;
      current.delivery.admission.kind !== "submitted" && attempt < 100;
      attempt += 1
    ) {
      // oxlint-disable-next-line no-await-in-loop -- Wait for the actual saved submission while the foreground model is held.
      await delay(1);
      // oxlint-disable-next-line no-await-in-loop -- Inspect the durable receipt after each scheduler step.
      current = await saved(fixture, event);
    }
    assert.equal(current.delivery.admission.kind, "submitted");
    assert.equal(Object.keys(await pending(fixture)).length, 1);
    const watch = await source.native.watch(context);
    try {
      const presentation = chatPresentation(watch.value);
      assert.deepEqual(presentation.queuedInputs, []);
      assert.equal(
        presentation.messages.some((message) =>
          message.text.includes("A compact event.")
        ),
        false
      );
    } finally {
      await watch.stop();
    }
    await fixture.pi().abortTask(receipt.delivery.taskId, context);
    await fixture.pi().waitForTask(receipt.delivery.taskId, context);
    current = await saved(fixture, event);
    assert.ok(
      current.delivery.admission.kind === "settled" &&
        current.delivery.admission.outcome === "unanswered",
      JSON.stringify(current.delivery.admission)
    );
    assert.deepEqual(await pending(fixture), {});
    release.resolve(true);
    await foreground.wait(context);
    assert.equal(source.faux.state.callCount, 1);
  } finally {
    release.resolve(true);
    await fixture.close();
  }
});

test("saved event reads require current read and content access without execution permission", async () => {
  const fixture = await setup();
  try {
    const event = {
      ...(await eventFor(fixture, "a")),
      dependencies: { sourceIds: [id.source("private-source")], toolIds: [] },
    };
    await fixture.events().admit(event, actor);
    const receipt = await wait(fixture, event);
    const source = fixture.source("a");
    let readAllowed = true;
    let contentAllowed = true;
    const operations: string[] = [];
    const scope = await ConversationScope.prototype.eventScope.call({
      native: source.native,
      coordination: source.coordinator,
      subscriptions: source.subscriptions,
      runtime: {
        authorize: (_caller: unknown, operation: string) => {
          operations.push(operation);
          if (operation !== "read" || !readAllowed) {
            return Promise.reject(
              new Denied({ code: "revoked", reason: "Execution is denied." })
            );
          }
          return Promise.resolve();
        },
        configuration: {
          agent: { version: 1 },
          coordination: source.coordinator.services,
          ownerContext: () => Effect.succeed(actor),
          checkDependencies: (
            _caller: unknown,
            dependencies: BotEvent["dependencies"]
          ) =>
            contentAllowed || dependencies.sourceIds.length === 0
              ? Effect.void
              : Effect.fail(
                  new Denied({ code: "revoked", reason: "Content is denied." })
                ),
        },
      },
    });
    const events = createCoordinatorEvents({
      pi: fixture.pi(),
      targetIn: () =>
        Promise.resolve({ nativeId: source.native.id, agentVersion: 1 }),
      resolve: () => Promise.resolve(scope),
      scan: () => Promise.resolve({ keys: [event.id] }),
      waitUntil: () =>
        assert.fail("Reading events must not start native work."),
    });
    assert.deepEqual(await events.read(event.id, actor), receipt);
    const page = await events.list(source.address, actor);
    assert.deepEqual(page.items, [receipt]);
    assert.deepEqual(operations, ["read", "read", "read"]);
    await assert.rejects(
      events.admit(event, actor),
      (error: unknown) => error instanceof Denied
    );
    await assert.rejects(
      scope.authorize(event, actor, undefined, "deliver"),
      (error: unknown) => error instanceof Denied
    );
    contentAllowed = false;
    await assert.rejects(
      events.read(event.id, actor),
      (error: unknown) => error instanceof Denied
    );
    await assert.rejects(
      events.list(source.address, actor),
      (error: unknown) => error instanceof Denied
    );
    contentAllowed = true;
    readAllowed = false;
    await assert.rejects(
      events.read(event.id, actor),
      (error: unknown) => error instanceof Denied
    );
    await assert.rejects(
      events.list(source.address, actor),
      (error: unknown) => error instanceof Denied
    );
    assert.equal(fixture.eventSubmissions.length, 1);
    assert.deepEqual(await pending(fixture), {});
  } finally {
    await fixture.close();
  }
});
